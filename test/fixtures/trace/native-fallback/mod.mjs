// Native ESM has no jiti `require` (with transform support), so this
// deterministically triggers jiti's native-import fallback to transform.
if (typeof require === "undefined" || !require.transform) {
  throw new Error("force jiti native fallback");
}

export const mode = "transformed";
