import { createImmutableContentCustody } from "../src/immutable-content-custody.mjs";

/** Retrieve an exact byte carrier through an explicitly supplied object-store capability. */
export async function getImmutableContent({ store, reference } = {}) {
  const result = await createImmutableContentCustody({ store }).get(reference);
  return result === null ? null : Object.freeze({ ...result, bytesBase64: Buffer.from(result.bytes).toString("base64") });
}

export const operation = Object.freeze({ name: "get-immutable-content", description: "Retrieve an exact byte carrier through an explicitly supplied object-store capability.", operation: getImmutableContent });
