import { getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasTableRow } from "@/types/canvas";

export type CanvasTableMediaEntry = {
    sourceNodeId: string;
    title: string;
    imageUrl: string;
    imageStorageKey?: string;
};

export type CanvasTablePromptEntry = {
    sourceNodeId: string;
    lineIndex: number;
    prompt: string;
};

function resourcesOf(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    return node.type === CanvasNodeType.Group ? getGroupResourceNodes(node.id, nodes) : [node];
}

/** Incoming image nodes (or images inside an incoming group): one entry per row of the input column. */
export function collectTableMediaEntries(tableId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasTableMediaEntry[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const seen = new Set<string>();
    const entries: CanvasTableMediaEntry[] = [];
    for (const connection of connections) {
        if (connection.toNodeId !== tableId) continue;
        const source = byId.get(connection.fromNodeId);
        if (!source) continue;
        for (const node of resourcesOf(source, nodes)) {
            if (seen.has(node.id)) continue;
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) continue;
            seen.add(node.id);
            entries.push({ sourceNodeId: node.id, title: node.title, imageUrl: node.metadata.content, imageStorageKey: node.metadata.storageKey });
        }
    }
    return entries;
}

/** Incoming text nodes (or text inside an incoming group), split by line into per-row prompts. */
export function collectTablePromptEntries(tableId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasTablePromptEntry[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const seen = new Set<string>();
    const entries: CanvasTablePromptEntry[] = [];
    for (const connection of connections) {
        if (connection.toNodeId !== tableId) continue;
        const source = byId.get(connection.fromNodeId);
        if (!source) continue;
        for (const node of resourcesOf(source, nodes)) {
            if (seen.has(node.id)) continue;
            if (node.type !== CanvasNodeType.Text) continue;
            const content = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!content) continue;
            seen.add(node.id);
            content
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .forEach((prompt, lineIndex) => entries.push({ sourceNodeId: node.id, lineIndex, prompt }));
        }
    }
    return entries;
}

function sameRow(left: CanvasTableRow, right: CanvasTableRow) {
    return (
        left.id === right.id &&
        left.prompt === right.prompt &&
        left.imageUrl === right.imageUrl &&
        left.imageStorageKey === right.imageStorageKey &&
        left.sourceNodeId === right.sourceNodeId &&
        left.sourceKind === right.sourceKind &&
        left.promptSourceNodeId === right.promptSourceNodeId &&
        left.promptLineIndex === right.promptLineIndex
    );
}

function sameRows(left: CanvasTableRow[], right: CanvasTableRow[]) {
    return left.length === right.length && left.every((row, index) => sameRow(row, right[index]));
}

function findMatchingManualImageRow(manualRows: CanvasTableRow[], entry: CanvasTableMediaEntry) {
    return manualRows.findIndex((row) => Boolean(entry.imageStorageKey && row.imageStorageKey === entry.imageStorageKey) || Boolean(entry.imageUrl && row.imageUrl === entry.imageUrl));
}

/**
 * Connection-driven table columns:
 * - wired images fill the input column, one row each;
 * - wired text lines fill the prompt column, zipped to the same row index;
 * - manual rows stay after them.
 * Existing rows keep their ids and manual prompts, so persisted canvases migrate in place.
 */
export function syncTableInputRows(tableNode: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (tableNode.type !== CanvasNodeType.Table) return { changed: false, node: tableNode };
    const mediaEntries = collectTableMediaEntries(tableNode.id, nodes, connections);
    const promptEntries = collectTablePromptEntries(tableNode.id, nodes, connections);
    const previousRows = tableNode.metadata?.rows || [];
    const manualRows = previousRows.filter((row) => !row.sourceNodeId && !row.promptSourceNodeId);
    const inputRows: CanvasTableRow[] = [];
    const rowCount = Math.max(mediaEntries.length, promptEntries.length);
    for (let index = 0; index < rowCount; index += 1) {
        const media = mediaEntries[index];
        const text = promptEntries[index];
        const existing =
            (media ? previousRows.find((row) => row.sourceNodeId === media.sourceNodeId) : undefined) ||
            (text ? previousRows.find((row) => row.promptSourceNodeId === text.sourceNodeId && (row.promptLineIndex ?? 0) === text.lineIndex) : undefined);
        let base = existing;
        if (!base && media) {
            const matchIndex = findMatchingManualImageRow(manualRows, media);
            if (matchIndex >= 0) base = manualRows.splice(matchIndex, 1)[0];
        }
        inputRows.push({
            id: base?.id || "input-" + (media ? media.sourceNodeId : (text?.sourceNodeId || "text") + "-line-" + (text?.lineIndex ?? 0)),
            prompt: text ? text.prompt : base?.prompt || "",
            imageUrl: media?.imageUrl ?? base?.imageUrl,
            imageStorageKey: media?.imageStorageKey ?? base?.imageStorageKey,
            sourceNodeId: media?.sourceNodeId,
            sourceKind: media ? "image" : text ? "text" : undefined,
            promptSourceNodeId: text?.sourceNodeId,
            promptLineIndex: text?.lineIndex,
        });
    }
    const rows = [...inputRows, ...manualRows];
    if (sameRows(rows, previousRows)) return { changed: false, node: tableNode };
    return { changed: true, node: { ...tableNode, metadata: { ...tableNode.metadata, rows } } };
}

/** Reconciles every table on the canvas after load or after connections change. */
export function syncAllTableInputs(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    let changed = false;
    const next = nodes.map((node) => {
        if (node.type !== CanvasNodeType.Table) return node;
        const result = syncTableInputRows(node, nodes, connections);
        if (result.changed) changed = true;
        return result.node;
    });
    return { changed, nodes: next };
}

/** Finds the table wired to a generation config node. Either edge direction is accepted. */
export function findConfigTable(configNodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const connection of connections) {
        const otherId = connection.fromNodeId === configNodeId ? connection.toNodeId : connection.toNodeId === configNodeId ? connection.fromNodeId : null;
        if (!otherId) continue;
        const table = byId.get(otherId);
        if (table?.type === CanvasNodeType.Table) return table;
    }
    return null;
}

/** Rows that can drive batch generation, including rows sourced from table connections. */
export function tableBatchRows(tableNode: CanvasNodeData | null, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (!tableNode) return [];
    const synced = syncTableInputRows(tableNode, nodes, connections).node;
    return (synced.metadata?.rows || []).filter((row) => row.prompt.trim() || row.imageUrl || row.imageStorageKey);
}

export function tableRowCountForConfig(configNodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return tableBatchRows(findConfigTable(configNodeId, nodes, connections), nodes, connections).length;
}

/** A table wired into an image node drives row-by-row generation into that node. */
export function findTableOutputTarget(imageNodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const connection of connections) {
        if (connection.toNodeId !== imageNodeId) continue;
        const source = byId.get(connection.fromNodeId);
        if (source?.type === CanvasNodeType.Table) return source;
    }
    return null;
}

/**
 * Earlier builds reversed "table output -> image node" drags into "image -> table input".
 * Empty image nodes cannot be real table inputs, so restore the intended direction on load.
 */
export function migrateTableOutputConnections(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let changed = false;
    const next = connections.map((connection) => {
        const from = byId.get(connection.fromNodeId);
        const to = byId.get(connection.toNodeId);
        if (!from || !to) return connection;
        if (from.type === CanvasNodeType.Image && !from.metadata?.content && to.type === CanvasNodeType.Table) {
            changed = true;
            return { ...connection, fromNodeId: to.id, toNodeId: from.id };
        }
        return connection;
    });
    return { changed, connections: changed ? next : connections };
}
