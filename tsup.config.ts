import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  outDir: "dist",
  // Bundle all dependencies into a single file — no node_modules needed at runtime.
  // This makes `npx openclaw-mcp-server` work without a separate install step.
  noExternal: [/.*/],
  // Inject #!/usr/bin/env node so npm/npx makes the binary executable
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Node built-ins stay external (they're always available)
  platform: "node",
  target: "node22",
  minify: false,
  sourcemap: false,
  clean: true,
  // Silence the "banner with ESM" warning — it's fine for CLI binaries
  silent: true,
});
