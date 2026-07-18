import { create } from "zustand";

type AppState = {
  selectedSubject: string | null;
  refreshToken: number;
  setSelectedSubject: (id: string | null) => void;
  refresh: () => void;
};
export const useAppStore = create<AppState>((set) => ({
  selectedSubject: null,
  refreshToken: 0,
  setSelectedSubject: (selectedSubject) => set({ selectedSubject }),
  refresh: () => set((s) => ({ refreshToken: s.refreshToken + 1 })),
}));
