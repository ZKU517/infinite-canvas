import { getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasTableRow } from "@/types/canvas";

export type CanvasTableInputEntry = {
    sourceNodeId: string;
    sourceKind: "image" | "text";
    title: string;
    prompt: string;
    imageUrl?: string;
    imageStorageKey?: string;
};

function resourcesOf(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    return node.type === CanvasNodeType.Group ? getGroupResourceNodes(node.id, nodes) : [node];
}

/** Reads the nodes wired into a table and turns them into input-column entries (one per image/text). */
export function collectTableInputEntries(tableId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasTableInputEntry[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const seen = new Set<string>();
    const entries: CanvasTableInputEntry[] = [];
    for (const connection of connections) {
        if (connection.toNodeId !== tableId) continue;
        const source = byId.get(connection.fromNodeId);
        if (!source) continue;
        for (const node of resourcesOf(source, nodes)) {
            if (seen.has(node.id)) continue;
            if (node.type === CanvasNodeType.Image && node.metadata?.content) {
                seen.add(node.id);
                entries.push({ sourceNodeId: node.id, sourceKind: "image", title: node.title, prompt: "", imageUrl: node.metadata.content, imageStorageKey: node.metadata.storageKey });
            } else if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) {
                seen.add(node.id);
                entries.push({ sourceNodeId: node.id, sourceKind: "text", title: node.title, prompt: (node.metadata?.content || node.metadata?.prompt || "").trim() });
            }
        }
    }
    return entries;
}

function sameRow(left: CanvasTableRow, right: CanvasTableRow) {
    return left.id === right.id && left.prompt === right.prompt && left.imageUrl === right.imageUrl && left.imageStorageKey === right.imageStorageKey && left.sourceNodeId === right.sourceNodeId && left.sourceKind === right.sourceKind;
}

function sameRows(left: CanvasTableRow[], right: CanvasTableRow[]) {
    return left.length === right.length && left.every((row, index) => sameRow(row, right[index]));
}

function findMatchingManualRow(manualRows: CanvasTableRow[], entry: CanvasTableInputEntry) {
    return manualRows.findIndex((row) => {
        if (entry.sourceKind === "image") return Boolean(entry.imageStorageKey && row.imageStorageKey === entry.imageStorageKey) || Boolean(entry.imageUrl && row.imageUrl === entry.imageUrl);
        return Boolean(entry.prompt && row.prompt === entry.prompt);
    });
}

/**
 * Connection-driven table inputs: every wired image/text becomes an input row, manual rows stay after them.
 * Existing rows keep their ids and cell prompts, so persisted canvases migrate in place.
 */
export function syncTableInputRows(tableNode: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (tableNode.type !== CanvasNodeType.Table) return { changed: false, node: tableNode };
    const entries = collectTableInputEntries(tableNode.id, nodes, connections);
    const previousRows = tableNode.metadata?.rows || [];
    const previousBySource = new Map(previousRows.filter((row) => row.sourceNodeId).map((row) => [row.sourceNodeId as string, row]));
    const manualRows = previousRows.filter((row) => !row.sourceNodeId);
    const inputRows: CanvasTableRow[] = entries.map((entry) => {
        const existing = previousBySource.get(entry.sourceNodeId);
        let base = existing;
        if (!base) {
            const matchIndex = findMatchingManualRow(manualRows, entry);
            if (matchIndex >= 0) base = manualRows.splice(matchIndex, 1)[0];
        }
        return {
            id: base?.id || "input-" + entry.sourceNodeId,
            prompt: entry.sourceKind === "text" ? entry.prompt : base?.prompt || "",
            imageUrl: entry.imageUrl ?? base?.imageUrl,
            imageStorageKey: entry.imageStorageKey ?? base?.imageStorageKey,
            sourceNodeId: entry.sourceNodeId,
            sourceKind: entry.sourceKind,
        };
    });
    const rows = [...inputRows, ...manualRows].map((row) => ({
        ...row,
        ...(row.sourceNodeId && !row.sourceKind ? { sourceKind: previousRows.find((item) => item.sourceNodeId === row.sourceNodeId)?.sourceKind || "image" } : {}),
    }));
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
