/**
 * Agent publication is a host-authorized operation over the ORIGINAL shared
 * immutable NI space, not an L-Space connector or a competing content store.
 * Caller JSON never supplies a directory, namespace inventory or credential.
 * The trusted host provides an independently authenticated context and the
 * canPublish decision for every named mutation and independent canLinkSource
 * admission for every linked preexisting NI.
 */
import { admitContentTreePath } from "./content-tree.mjs";

const DEFAULT_INPUT_BUDGET = 1024 * 1024;
const publication = Object.freeze({
  readOnlyHint: false, destructiveHint: false, idempotentHint: false,
});
const objectSchema = (properties, required) => Object.freeze({
  type: "object", properties: Object.freeze(properties),
  required: Object.freeze(required), additionalProperties: false,
});
const requiredName = {type:"string", minLength:1, maxLength:512};
const requiredPath = {type:"array", minItems:1, maxItems:16,
  items:{type:"string",minLength:1,maxLength:128,pattern:"^[a-z0-9][a-z0-9._-]*$"}};
const expected = {anyOf:[{type:"null"},{type:"string",minLength:1}]};
const present = (input, allowed, required) => {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
       Object.getPrototypeOf(input) !== null) ||
      Reflect.ownKeys(input).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(input,key))) {
    throw new TypeError("content space publication: only declared JSON operation fields are admitted");
  }
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input,key);
    if (!Object.hasOwn(property,"value"))
      throw new TypeError("content space publication: accessor fields are not admitted");
  }
};
const strictBytes = (encoded, budget) => {
  if (typeof encoded !== "string" || encoded.length > Math.ceil(budget / 3) * 4 ||
      !/^[A-Za-z0-9_-]*$/u.test(encoded)) {
    throw new TypeError("content space publication: unpadded canonical base64url bytes required");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength > budget || bytes.toString("base64url") !== encoded)
    throw new TypeError("content space publication: noncanonical or oversized bytes");
  return bytes;
};

/**
 * Compose the same strict source custody producer used by other Code,
 * Science and Operations clients into an MCP host that has real actor grants.
 * The canPublish callback MUST decide from host-authenticated principal data;
 * caller fields, headers and claimed office names never grant rights.
 */
export function createContentSpacePublicationMcpTools({
  contentSpace, canPublish, canLinkSource, maximumInputBytes = DEFAULT_INPUT_BUDGET,
} = {}) {
  if (contentSpace?.kind !== "semiotic-content.addressed-space.v1" ||
      !Array.isArray(contentSpace.namespaces) ||
      typeof contentSpace.putPath !== "function" ||
      typeof contentSpace.linkPath !== "function" ||
      typeof canPublish !== "function" || typeof canLinkSource !== "function")
    throw new TypeError("content space publication: original installed space and host authorization are required");
  if (!Number.isSafeInteger(maximumInputBytes) || maximumInputBytes < 1 ||
      maximumInputBytes > 8 * 1024 * 1024)
    throw new RangeError("content space publication: input budget must be 1 through 8 MiB");
  const names = new Set(contentSpace.namespaces);
  const authorize = async (input, allowed, required, verb, context) => {
    present(input,allowed,required);
    const { name, expected: before } = input;
    const path = admitContentTreePath(input.path);
    if (typeof name !== "string" || !names.has(name) ||
        (before !== null && typeof before !== "string"))
      throw new RangeError("content space publication: coordinate not admitted");
    const grant = await canPublish(context, Object.freeze({
      action:verb, name, path,
    }));
    if (grant !== true)
      throw new RangeError("content space publication: coordinate not admitted");
    return {name, expected:before, path};
  };
  const put = async (input, context) => {
    const coordinate = await authorize(input,
      ["name","expected","path","base64url","mediaType"],
      ["name","expected","path","base64url"],"put",context);
    const bytes = strictBytes(input.base64url,maximumInputBytes);
    const mediaType = input.mediaType ?? "application/octet-stream";
    if (typeof mediaType !== "string" || /[\r\n]/u.test(mediaType))
      throw new TypeError("content space publication: canonical media type required");
    // The ORIGINAL MIME parser, writer, NI and compare-and-publish owners
    // decide canonical media, actual content identity and root movement.
    const written = await contentSpace.putPath({...coordinate,bytes,mediaType});
    if (written?.published !== true || written.retained?.durable !== true)
      throw new Error("content space publication: no confirmed durable root movement");
    return Object.freeze({
      kind:"semiotic-content.named-publication",version:1,action:"put",
      name:written.name,before:written.before,rootNi:written.rootNi,
      ni:written.ni,path:written.path,byteLength:written.retained.byteLength,
      mediaType:written.retained.mediaType,durable:true,
    });
  };
  const link = async (input, context) => {
    const coordinate = await authorize(input,
      ["name","expected","path","ni"],["name","expected","path","ni"],"link",context);
    if (typeof input.ni !== "string")
      throw new TypeError("content space publication: original NI address required");
    // Publishing an existing address must not launder an inaccessible source
    // through an otherwise writable destination namespace. The host makes
    // this separate NI-specific, principal-derived admission decision.
    if ((await canLinkSource(context,input.ni)) !== true)
      throw new RangeError("content space publication: source NI not admitted");
    const written = await contentSpace.linkPath({...coordinate,ni:input.ni});
    if (written?.published !== true)
      throw new Error("content space publication: no confirmed root movement");
    return Object.freeze({
      kind:"semiotic-content.named-publication",version:1,action:"link",
      name:written.name,before:written.before,rootNi:written.rootNi,
      ni:written.ni,path:written.path,
    });
  };
  return Object.freeze([
    Object.freeze({
      name:"content_space_put_path",
      description:"Publish exact canonical base64url bytes into an authorized named Merkle collection using the original durable NI producer and expected-root CAS. The host authenticates each principal; no filesystem root, credential or grant is accepted in arguments.",
      inputSchema:objectSchema({
        name:requiredName,expected,path:requiredPath,
        base64url:{type:"string",maxLength:Math.ceil(maximumInputBytes / 3)*4,
          description:"Exact unpadded base64url raw bytes, including empty string for empty content"},
        mediaType:{type:"string",minLength:1,maxLength:4095},
      },["name","expected","path","base64url"]),
      annotations:publication,handler:put,
    }),
    Object.freeze({
      name:"content_space_link_path",
      description:"Publish an independently readable, previously retained NI resource under an authorized immutable Merkle slot using expected-root CAS. The host must grant both destination publication and source-NI access; no bytes are copied.",
      inputSchema:objectSchema({
        name:requiredName,expected,path:requiredPath,
        ni:{type:"string",minLength:1,description:"Original retained RFC 6920 ni URI"},
      },["name","expected","path","ni"]),
      annotations:publication,handler:link,
    }),
  ]);
}
