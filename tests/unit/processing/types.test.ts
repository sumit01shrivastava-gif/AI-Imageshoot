import { describe, expect, it } from "vitest";
import { ImageOperation } from "@prisma/client";
import { IMAGE_OPERATIONS, IMPLEMENTED_OPERATIONS } from "../../../services/processing/types";

describe("IMAGE_OPERATIONS", () => {
  it("mirrors prisma/schema.prisma's ImageOperation enum exactly", () => {
    const prismaValues = Object.values(ImageOperation).sort();
    const localValues = [...IMAGE_OPERATIONS].sort();
    expect(localValues).toEqual(prismaValues);
  });

  it("IMPLEMENTED_OPERATIONS is a subset of IMAGE_OPERATIONS", () => {
    for (const op of IMPLEMENTED_OPERATIONS) {
      expect(IMAGE_OPERATIONS).toContain(op);
    }
  });
});
