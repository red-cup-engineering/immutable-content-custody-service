import { createImmutableContentCustody } from "../src/immutable-content-custody.mjs";

/** Retain exact bytes through an explicitly supplied object-store capability. */
export async function putImmutableContent({ store, ni, bytesBase64, mediaType } = {}) {
  if (typeof bytesBase64 !== "string") throw new TypeError("bytesBase64 must be a base64 string");
  return createImmutableContentCustody({ store }).put({ ni, bytes: Buffer.from(bytesBase64, "base64"), mediaType });
}

export const operation = Object.freeze({ name: "put-immutable-content", description: "Retain exact bytes through an explicitly supplied object-store capability.", operation: putImmutableContent });
