export interface ParsedFrontmatter {
	properties: Record<string, unknown>;
	tags: string[];
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(content: string): ParsedFrontmatter {
	const match = content.match(FRONTMATTER_RE);
	if (!match) return { properties: {}, tags: [] };

	const properties = parseYamlBlock(match[1] ?? "");

	const rawTags = properties["tags"] ?? properties["tag"] ?? [];
	const tags = normalizeTags(rawTags);

	return { properties, tags };
}

function normalizeTags(raw: unknown): string[] {
	if (Array.isArray(raw))
		return raw.map(String).map((t) => t.replace(/^#/, "").trim());
	if (typeof raw === "string") return [raw.replace(/^#/, "").trim()];
	return [];
}

function parseYamlBlock(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = yaml.split(/\r?\n/);
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? "";

		if (!line.trim() || line.trimStart().startsWith("#")) {
			i++;
			continue;
		}

		const keyMatch = line.match(/^([\w][\w\s-]*?)\s*:\s*(.*)/);
		if (!keyMatch) {
			i++;
			continue;
		}

		const key = keyMatch[1]?.trim() ?? "";
		const valueStr = keyMatch[2]?.trim() ?? "";

		if (valueStr === "" || valueStr === "|" || valueStr === ">") {
			const items: string[] = [];
			i++;
			while (i < lines.length && /^[ \t]/.test(lines[i] ?? "")) {
				const currentLine = lines[i] ?? "";
				const itemMatch = currentLine.match(/^[ \t]+-[ \t]*(.*)/);
				if (itemMatch) {
					const v = itemMatch[1]?.trim() ?? "";
					if (v) items.push(v);
				} else {
					const stripped = currentLine.trim();
					if (stripped) items.push(stripped);
				}
				i++;
			}
			result[key] = items.length > 0 ? items : null;
		} else {
			result[key] = parseScalar(valueStr);
			i++;
		}
	}

	return result;
}

function parseScalar(value: string): unknown {
	if (value === "true" || value === "yes") return true;
	if (value === "false" || value === "no") return false;
	if (value === "null" || value === "~" || value === "") return null;

	if (value.startsWith("[") && value.endsWith("]")) {
		return value
			.slice(1, -1)
			.split(",")
			.map((s) => parseScalar(s.trim()))
			.filter((s) => s !== null && s !== "");
	}

	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}

	if (/^-?\d+$/.test(value)) return parseInt(value, 10);
	if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

	return value;
}
