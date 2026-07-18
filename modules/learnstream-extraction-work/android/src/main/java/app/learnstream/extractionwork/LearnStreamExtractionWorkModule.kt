package app.learnstream.extractionwork

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.TimeUnit

class LearnStreamExtractionWorkModule : Module() {
  override fun definition() = ModuleDefinition {
    Name(MODULE_NAME)

    AsyncFunction("schedule") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()
      val request = OneTimeWorkRequestBuilder<LearnStreamExtractionWorker>()
        .setConstraints(constraints)
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 60, TimeUnit.SECONDS)
        .addTag(UNIQUE_WORK_NAME)
        .build()

      WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
        UNIQUE_WORK_NAME,
        ExistingWorkPolicy.KEEP,
        request
      )
      true
    }
  }

  companion object {
    private const val MODULE_NAME = "LearnStreamExtractionWork"
    private const val UNIQUE_WORK_NAME = "learnstream-immediate-extraction"
  }
}
