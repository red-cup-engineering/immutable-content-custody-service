function input() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    process.stdin.on("error", reject);
  });
}

/** CLI adapter: the object store is an explicit module capability, never a selected provider. */
export async function runCustodyCommand(action) {
  try {
    const value = await input();
    if (typeof value.storeModule !== "string" || value.storeModule === "") throw new TypeError("storeModule must explicitly name an object-store capability module");
    const module = await import(value.storeModule);
    const store = module.store ?? module.default;
    process.stdout.write(`${JSON.stringify(await action({ ...value, store }))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ kind: "immutable-content-custody-refusal", code: error?.code ?? "invalid-input", message: error?.message ?? String(error) })}\n`);
    process.exitCode = 1;
  }
}
