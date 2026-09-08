import React from "react";
import { Pressable, RefreshControl, Text } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FeedScreen from "../../app/(tabs)/index";

const services = vi.hoisted(() => ({
  feed: vi.fn(), generate: vi.fn(), unsubscribe: vi.fn(), action: vi.fn(), setSelected: vi.fn(),
}));
vi.mock("../../src/db/database", () => ({ listSubjects: async () => [] }));
vi.mock("../../src/services/feed", () => ({ loadRankedFeed: services.feed }));
vi.mock("../../src/services/autogeneration", () => ({ requestAutoGeneration: services.generate, subscribeToGeneratedPosts: () => services.unsubscribe }));
vi.mock("../../src/services/interactions", () => ({ recordAction: services.action }));
vi.mock("../../src/state/app", () => ({ useAppStore: (selector: (state: unknown) => unknown) => selector({ selectedSubject: null, setSelectedSubject: services.setSelected }) }));
vi.mock("./PostCard", () => ({ default: "PostCard" }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return { useRouter: () => ({ push: () => {} }), useFocusEffect: (effect: () => (() => void)) => useEffect(effect, [effect]) };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", RefreshControl: "RefreshControl",
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
vi.mock("@shopify/flash-list", async () => {
  const { createElement } = await import("react");
  return { FlashList: (props: { refreshControl: React.ReactNode }) => createElement("FeedList", { ...props, testID: "feed-list" }, props.refreshControl) };
});
vi.mock("./components", async () => {
  const { createElement } = await import("react");
  return {
    Screen: ({ children }: { children: React.ReactNode }) => createElement("Screen", {}, children),
    Header: "Header", Loading: "Loading",
    Empty: ({ action, ...props }: { action: React.ReactNode }) => createElement("Empty", props, action),
  };
});

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  services.feed.mockImplementation(async (_subject: unknown, options: { savedOnly: boolean }) => [{ id: options.savedOnly ? "saved-post" : "all-post" }]);
  services.action.mockResolvedValue(undefined);
});
afterEach(async () => { if (renderer) await act(async () => { renderer!.unmount(); }); renderer = undefined; });

it("does not replace a saved feed when an earlier pull-refresh finishes", async () => {
  let finish!: (result: unknown) => void;
  let refreshing!: Promise<void>;
  services.generate.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => { renderer = create(<FeedScreen />); });
  await act(async () => { refreshing = renderer!.root.findByType(RefreshControl).props.onRefresh(); });
  await act(async () => {
    renderer!.root.findAll((node) => node.type === Pressable && node.findAll((child) => child.type === Text && child.props.children === "保存済み").length > 0)[0].props.onPress();
  });
  expect(renderer!.root.findByProps({ testID: "feed-list" }).props.data).toEqual([{ id: "saved-post" }]);
  await act(async () => { finish({ status: "failed", errorMessage: "Old request failed" }); await refreshing; });
  expect(renderer!.root.findByProps({ testID: "feed-list" }).props.data).toEqual([{ id: "saved-post" }]);
  expect(services.feed).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findAllByType(Text).some((node) => String(node.props.children).includes("Old request failed"))).toBe(false);
  expect(services.unsubscribe).toHaveBeenCalled();
});
