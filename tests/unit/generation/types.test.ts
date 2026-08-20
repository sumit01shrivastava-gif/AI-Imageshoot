import { describe, expect, it } from "vitest";
import { GenerationType } from "@prisma/client";
import { GENERATION_TYPES } from "../../../services/generation/types";

describe("GENERATION_TYPES", () => {
  it("mirrors prisma/schema.prisma's GenerationType enum exactly", () => {
    // GENERATION_TYPES is kept as an independent string-literal union (see
    // types.ts's doc comment) — this test is what catches the two drifting
    // apart if the Prisma enum is ever changed without updating this file.
    const prismaValues = Object.values(GenerationType).sort();
    const localValues = [...GENERATION_TYPES].sort();
    expect(localValues).toEqual(prismaValues);
  });
});
