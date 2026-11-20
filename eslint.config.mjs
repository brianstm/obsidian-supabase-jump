import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default tseslint.config(
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.json",
			},
		},
		rules: {
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-argument": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-return": "error",
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					allowAutoFix: true,
					brands: ["Supabase jump", "Supabase", "Jump", "Google Docs", "Obsidian", "SQL"],
				},
			],
		},
	},
	{
		ignores: [
			"node_modules",
			"dist",
			"esbuild.config.mjs",
			"eslint.config.js",
			"eslint.config.mjs",
			"version-bump.mjs",
			"versions.json",
			"main.js",
			"test",
		],
	},
);
