/**
 * Pure category-aware lifestyle scene defaulting — see
 * docs/lifestyle-generation.md "Category-aware lifestyle imagery" and
 * "LifestyleScenePlan". No I/O; everything it needs is passed in already
 * resolved (mirrors services/intelligence/build-input.ts's shape).
 *
 * Resolution order (a preset's own attributes always win over category
 * defaults; a merchant scene override, if the UI ever exposes one,
 * always wins over both — see build-plan.ts's LIFESTYLE branch, the
 * only caller of `buildLifestyleScene` below):
 *   1. category-aware defaults (this file, via
 *      services/intelligence/category-recommendations.ts — reused, not
 *      duplicated)
 *   2. the resolved brand style preset's attributes (built-in or custom)
 *   3. any merchant scene-control override
 */
import { getCategoryRecommendation } from "../intelligence/category-recommendations";
import type { BrandStylePresetAttributes, LifestyleScene } from "./schema";

export interface LifestyleSceneOverride {
  environment?: string | null;
  surface?: string | null;
  props?: string[];
  camera?: string | null;
  mood?: string | null;
  colorDirection?: string | null;
  negativeConstraints?: string[];
}

export interface BuildLifestyleSceneInput {
  /** Free-text signal used for category matching — see
   * getCategoryRecommendation's own doc comment (category/productType/
   * title, whatever's available). */
  categorySignal: string;
  preset: BrandStylePresetAttributes | null;
  override?: LifestyleSceneOverride;
}

export interface LifestyleSceneResolution {
  scene: LifestyleScene;
  /** The environment used for `creativeDirection.environment` — kept
   * separate from `scene` since `environment` lives at the
   * `creativeDirection` level (see schema.ts's `LifestyleSceneSchema` doc
   * comment for why), not inside `lifestyleScene` itself. */
  environment: string | null;
  negativeConstraints: string[];
  /** Photography style, for `creativeDirection.prompt` synthesis — from
   * the preset if set, else the category's own recommendation. */
  photographyStyle: string | null;
}

/**
 * Resolves the full lifestyle scene configuration for one generation
 * request. Never throws — every field has a safe fallback
 * (`getCategoryRecommendation` itself never throws either).
 */
export function buildLifestyleScene(input: BuildLifestyleSceneInput): LifestyleSceneResolution {
  const { categorySignal, preset, override } = input;
  const categoryDefaults = getCategoryRecommendation(categorySignal);

  const surface = override?.surface ?? preset?.surface ?? categoryDefaults.recommendedSurfaces?.[0] ?? null;
  const props = override?.props ?? preset?.props ?? categoryDefaults.recommendedProps ?? [];
  const mood = override?.mood ?? preset?.mood ?? categoryDefaults.recommendedMood ?? null;
  const colorDirection =
    override?.colorDirection ?? preset?.colorDirection ?? categoryDefaults.recommendedColorDirection ?? null;
  const environment =
    override?.environment ?? preset?.environment ?? categoryDefaults.recommendedEnvironments[0] ?? null;
  const camera = override?.camera ?? null;
  const negativeConstraints = override?.negativeConstraints ?? preset?.negativeConstraints ?? [];
  const photographyStyle = preset?.photographyStyle ?? null;

  return {
    scene: {
      // "in-use"/environmental placement is the default lifestyle
      // treatment; a future phase could make this merchant-selectable
      // too, but nothing in this phase's UI exposes it yet.
      sceneType: "environmental",
      surface,
      props,
      camera,
      mood,
      colorDirection,
    },
    environment,
    negativeConstraints,
    photographyStyle,
  };
}
