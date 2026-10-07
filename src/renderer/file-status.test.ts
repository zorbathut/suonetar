import { describe, expect, it } from "vitest";
import { renameLabel } from "./file-status.ts";

describe("renameLabel", () => {
	it("braces only what changed, keeping the directories either side", () => {
		expect(renameLabel("project/src/graph/DebugDialogueGraphWindow.cs", "project/src/graph/DebugGraphEditorWindow.cs")).toBe(
			"project/src/graph/{DebugDialogueGraphWindow.cs → DebugGraphEditorWindow.cs}",
		);
		expect(renameLabel("project/ui/command/EditorBase.cs", "project/ui/editor/command/EditorBase.cs")).toBe("project/ui/{ → editor}/command/EditorBase.cs");
		expect(renameLabel("a/b/c", "a/c")).toBe("a/{b → }/c");
		expect(renameLabel("a.txt", "dir/a.txt")).toBe("{ → dir}/a.txt");
	});

	it("is the two paths whole when they share nothing", () => {
		expect(renameLabel("x.txt", "y.txt")).toBe("x.txt → y.txt");
		expect(renameLabel("a/x.txt", "b/y.txt")).toBe("a/x.txt → b/y.txt");
	});
});
