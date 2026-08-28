import type { GenerationProgressStage } from "../../services/generation/progress";

export type ActiveGenerationProgressStage = Exclude<GenerationProgressStage, "COMPLETED" | "FAILED">;

export const generationProgressPresentation: Record<ActiveGenerationProgressStage, { title: string; copy: readonly string[]; step: 0 | 1 | 2 }> = {
  PREPARING: {
    title: "Reading your direction…",
    copy: ["Reading the product and your direction…", "Understanding what should stay untouched…"],
    step: 0,
  },
  PLANNING: {
    title: "Setting the creative direction…",
    copy: ["Building the creative direction…", "Setting the campaign composition…"],
    step: 0,
  },
  QUEUED: {
    title: "Setting the creative direction…",
    copy: ["Setting the creative direction…", "Preparing the visual world…"],
    step: 0,
  },
  GENERATING: {
    title: "Creating your image…",
    copy: ["Building the campaign world…", "Shaping light, materials and composition…", "Bringing the scene together…"],
    step: 1,
  },
  CHECKING_QUALITY: {
    title: "Checking the finished image…",
    copy: ["Checking product fidelity…", "Reviewing the final details…"],
    step: 2,
  },
};
