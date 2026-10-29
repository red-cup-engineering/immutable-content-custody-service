/**
 * @param {string} ni Canonical content identity.
 * @returns {string} Immutable object-store key.
 * @throws {TypeError} If the identity is not a canonical SHA-256 ni URI.
 */
export function immutableContentKey(ni: string): string;
/**
 * @typedef {{body: Uint8Array, mediaType?: string, etag?: string}} StoredContent
 * @typedef {{get: (key: string) => Promise<StoredContent | null>, putCurrent: (key: string, value: StoredContent & {byteLength: number, sha256: string}) => Promise<unknown>}} ContentStore
 * @typedef {{profile: string, ni: string, key: string, byteLength: number, mediaType: string}} ContentReference
 */
/**
 * @param {{store?: ContentStore, maximumBytes?: number}} [options] Injected custody boundary and upload limit.
 * @returns {{put: (input: {ni: string, bytes: Uint8Array, mediaType?: string}) => Promise<Readonly<ContentReference>>, get: (reference: string | ContentReference) => Promise<Readonly<{ni: string, bytes: Buffer, mediaType: string, etag: string | undefined}> | null>}} Verified custody operations.
 * @throws {TypeError} If the store lacks its required operations.
 * @throws {RangeError} If maximumBytes is not a positive safe integer.
 */
export function createImmutableContentCustody({ store, maximumBytes: offeredMaximum }?: {
    store?: ContentStore;
    maximumBytes?: number;
}): {
    put: (input: {
        ni: string;
        bytes: Uint8Array;
        mediaType?: string;
    }) => Promise<Readonly<ContentReference>>;
    get: (reference: string | ContentReference) => Promise<Readonly<{
        ni: string;
        bytes: Buffer;
        mediaType: string;
        etag: string | undefined;
    }> | null>;
};
/**
 * Read current bytes on every call and memoize one pure verifier by exact content.
 * The reader instance fixes verifier identity; verification must depend only on bytes.
 * Results are deeply frozen records/arrays. Limits bound retained input bytes and
 * result count; oversized inputs are verified without retention. Throws are not cached.
 * @template Key, Value
 * @param {{read: (key: Key) => Uint8Array, verify: (bytes: Buffer) => Value, maximumEntries?: number, maximumBytes?: number}} options
 * @returns {(key: Key) => Value} Synchronous verified read operation.
 * @throws {TypeError} If an adapter or its input/result is unsupported.
 * @throws {RangeError} If a cache limit is not a positive safe integer.
 */
export function createVerifiedContentReader<Key, Value>({ read, verify: verifyContent, maximumEntries, maximumBytes: byteBudget }: {
    read: (key: Key) => Uint8Array;
    verify: (bytes: Buffer) => Value;
    maximumEntries?: number;
    maximumBytes?: number;
}): (key: Key) => Value;
/** @type {string} */
export const IMMUTABLE_CONTENT_REFERENCE_PROFILE: string;
/** @type {number} */
export const IMMUTABLE_CONTENT_DEFAULT_MAXIMUM_BYTES: number;
export type StoredContent = {
    body: Uint8Array;
    mediaType?: string;
    etag?: string;
};
export type ContentStore = {
    get: (key: string) => Promise<StoredContent | null>;
    putCurrent: (key: string, value: StoredContent & {
        byteLength: number;
        sha256: string;
    }) => Promise<unknown>;
};
export type ContentReference = {
    profile: string;
    ni: string;
    key: string;
    byteLength: number;
    mediaType: string;
};
