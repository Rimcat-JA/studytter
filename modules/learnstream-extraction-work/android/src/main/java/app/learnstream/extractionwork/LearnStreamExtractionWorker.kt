package app.learnstream.extractionwork

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import expo.modules.backgroundtask.BackgroundTaskConsumer
import expo.modules.interfaces.taskManager.TaskServiceProviderHelper
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Executes registered Expo background-task consumers immediately while
 * WorkManager holds a data-sync foreground service. Expo invokes each callback
 * only after its JavaScript promise settles, so an extraction already running
 * in the UI remains protected when the Activity is closed.
 */
class LearnStreamExtractionWorker(
  context: Context,
  params: WorkerParameters
) : CoroutineWorker(context, params) {
  override suspend fun doWork(): Result {
    try {
      setForeground(createForegroundInfo())
    } catch (error: IllegalStateException) {
      // Android 12+ can reject a foreground-service start when this is a
      // WorkManager retry and the app is already backgrounded. The scheduled
      // Worker still owns a process lifetime and a nine-minute watchdog, so
      // continue as regular work instead of turning a recoverable retry into
      // a terminal WorkManager failure.
      Log.w(TAG, "Foreground service unavailable; continuing as regular work", error)
    }

    return try {
      val consumers = TaskServiceProviderHelper
        .getTaskServiceImpl(applicationContext)
        ?.getTaskConsumers(applicationContext.packageName)
        ?.filterIsInstance<BackgroundTaskConsumer>()
        .orEmpty()

      if (consumers.isEmpty()) {
        Log.w(TAG, "No registered Expo background-task consumers were found")
        retryOrFail("No registered background task")
      } else {
        val responses = withTimeoutOrNull(MAX_EXECUTION_MILLIS) {
          coroutineScope {
            consumers.map { consumer ->
              async {
                suspendCancellableCoroutine { continuation ->
                  consumer.executeTask { response ->
                    if (continuation.isActive) continuation.resume(response)
                  }
                }
              }
            }.awaitAll()
          }
        }
        if (responses == null) {
          // TaskService has its own slightly shorter native watchdog. This is
          // the final guard that returns control to WorkManager before Android
          // can stop the job without a durable retry decision.
          Log.w(TAG, "Expo background-task callback timed out")
          retryOrFail("Expo background-task callback timed out")
        } else {
          val taskFailed = responses.any { response ->
            (response["result"] as? Number)?.toInt() == BACKGROUND_TASK_FAILED
          }

          if (taskFailed) {
            Log.w(TAG, "At least one Expo background task requested a retry")
            retryOrFail("Background task returned Failed")
          } else {
            Result.success()
          }
        }
      }
    } catch (cancellation: CancellationException) {
      throw cancellation
    } catch (error: Exception) {
      Log.e(TAG, "Immediate extraction worker failed", error)
      retryOrFail(error.message ?: error.javaClass.simpleName)
    }
  }

  private fun retryOrFail(message: String): Result {
    if (runAttemptCount < MAX_RETRY_COUNT) return Result.retry()

    return Result.failure(
      Data.Builder()
        .putString("error", message)
        .build()
    )
  }

  private fun createForegroundInfo(): ForegroundInfo {
    createNotificationChannel()
    val launchIntent = applicationContext.packageManager
      .getLaunchIntentForPackage(applicationContext.packageName)
      ?.apply {
        flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
      }
    val pendingIntent = launchIntent?.let {
      PendingIntent.getActivity(
        applicationContext,
        NOTIFICATION_ID,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    val notification = NotificationCompat.Builder(applicationContext, NOTIFICATION_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(applicationContext.getString(R.string.learnstream_extraction_notification_title))
      .setContentText(applicationContext.getString(R.string.learnstream_extraction_notification_body))
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setProgress(0, 0, true)
      .build()

    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ForegroundInfo(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      )
    } else {
      ForegroundInfo(NOTIFICATION_ID, notification)
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

    val manager = applicationContext.getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      NOTIFICATION_CHANNEL_ID,
      applicationContext.getString(R.string.learnstream_extraction_notification_channel),
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = applicationContext.getString(
        R.string.learnstream_extraction_notification_channel_description
      )
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  companion object {
    private const val TAG = "LearnStreamExtraction"
    private const val NOTIFICATION_CHANNEL_ID = "learnstream_extraction"
    private const val NOTIFICATION_ID = 4102
    private const val BACKGROUND_TASK_FAILED = 2
    // One WorkManager attempt can occur before the job's Retry-After deadline.
    // Keep the native ceiling above the durable database job's eight attempts
    // so that an early poll cannot prematurely stop automatic recovery.
    private const val MAX_RETRY_COUNT = 16
    private const val MAX_EXECUTION_MILLIS = 9L * 60L * 1000L
  }
}
