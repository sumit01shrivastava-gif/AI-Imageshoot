import { describe, expect, it } from "vitest";
import { StoreVisualType } from "@prisma/client";
import { STORE_VISUAL_TYPES } from "../../../services/store-visuals/types";

describe("STORE_VISUAL_TYPES", () => {
  it("mirrors prisma/schema.prisma's StoreVisualType enum exactly", () => {
    const prismaValues = Object.values(StoreVisualType).sort();
    const localValues = [...STORE_VISUAL_TYPES].sort();
    expect(localValues).toEqual(prismaValues);
  });
});
