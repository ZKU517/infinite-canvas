import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle, type ViewportTransform } from "@/types/canvas";

export function nodeBounds(nodes: CanvasNodeData[]) {
    return nodes.reduce(
        (acc, node) => ({
            left: Math.min(acc.left, node.position.x),
            top: Math.min(acc.top, node.position.y),
            right: Math.max(acc.right, node.position.x + node.width),
            bottom: Math.max(acc.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

function containsCenter(group: CanvasNodeData, node: CanvasNodeData) {
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
}

export function findGroupDropTarget(movedIds: Set<string>, nodes: CanvasNodeData[]) {
    if (nodes.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group)) return null;
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return null;
    // Walk backwards instead of copying and reversing; this runs on every drag frame.
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const group = nodes[index];
        if (group.type !== CanvasNodeType.Group || movedIds.has(group.id)) continue;
        if (movingNodes.some((node) => containsCenter(group, node))) return group;
    }
    return null;
}

export function snapNodesIntoGroup(movedIds: Set<string>, nodes: CanvasNodeData[], group: CanvasNodeData) {
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return nodes;
    const pad = 24;
    const bounds = nodeBounds(movingNodes);
    const left = group.position.x + pad;
    const top = group.position.y + pad;
    const right = group.position.x + group.width - pad;
    const bottom = group.position.y + group.height - pad;
    const dx = bounds.right - bounds.left > right - left ? left - bounds.left : bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
    const dy = bounds.bottom - bounds.top > bottom - top ? top - bounds.top : bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
    return nodes.map((node) => {
        if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
        return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy }, metadata: { ...node.metadata, groupId: group.id } };
    });
}

export const GROUP_WRAP_PADDING = 24;
export const GROUP_WRAP_TOP_PADDING = 52;

function selectedGroupIds(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    return new Set(nodes.filter((node) => selectedIds.has(node.id) && node.type === CanvasNodeType.Group).map((node) => node.id));
}

export function collectGroupMemberNodes(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    const groups = selectedGroupIds(selectedIds, nodes);
    return nodes.filter((node) => node.type !== CanvasNodeType.Group && (selectedIds.has(node.id) || (node.metadata?.groupId != null && groups.has(node.metadata.groupId))));
}

export function getGroupWrapRect(members: CanvasNodeData[]) {
    const bounds = nodeBounds(members);
    return {
        x: bounds.left - GROUP_WRAP_PADDING,
        y: bounds.top - GROUP_WRAP_TOP_PADDING,
        width: bounds.right - bounds.left + GROUP_WRAP_PADDING * 2,
        height: bounds.bottom - bounds.top + GROUP_WRAP_TOP_PADDING + GROUP_WRAP_PADDING,
    };
}

/**
 * Re-fits a group to its current members (same padding as group creation).
 * Returns null when the group has no members or already matches.
 */
export function fitGroupBounds(group: CanvasNodeData, nodes: CanvasNodeData[]) {
    if (group.type !== CanvasNodeType.Group) return null;
    const members = nodes.filter((node) => node.id !== group.id && node.metadata?.groupId === group.id);
    if (!members.length) return null;
    const rect = getGroupWrapRect(members);
    if (Math.abs(group.position.x - rect.x) < 0.5 && Math.abs(group.position.y - rect.y) < 0.5 && Math.abs(group.width - rect.width) < 0.5 && Math.abs(group.height - rect.height) < 0.5) return null;
    return { ...group, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height };
}

/**
 * Keeps group edges tight around their children. Passing groupIds limits the work to groups touched by
 * the current interaction; without it every group is checked.
 */
export function fitGroupsToMembers(nodes: CanvasNodeData[], groupIds?: Iterable<string>) {
    const ids = groupIds ? new Set(groupIds) : null;
    let changed = false;
    const next = nodes.map((node) => {
        if (node.type !== CanvasNodeType.Group) return node;
        if (ids && !ids.has(node.id)) return node;
        const fitted = fitGroupBounds(node, nodes);
        if (!fitted) return node;
        changed = true;
        return fitted;
    });
    return changed ? next : nodes;
}

export function canGroupSelectedNodes(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    const members = collectGroupMemberNodes(selectedIds, nodes);
    if (members.length < 2) return false;
    const groupId = members[0].metadata?.groupId;
    return !groupId || members.some((node) => node.metadata?.groupId !== groupId);
}

export function canUngroupSelectedNodes(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    return nodes.some((node) => selectedIds.has(node.id) && (node.type === CanvasNodeType.Group || Boolean(node.metadata?.groupId)));
}

function emptyGroupIds(nodes: CanvasNodeData[], keepId?: string) {
    const used = new Set(nodes.flatMap((node) => (node.type !== CanvasNodeType.Group && node.metadata?.groupId ? [node.metadata.groupId] : [])));
    return new Set(nodes.filter((node) => node.type === CanvasNodeType.Group && node.id !== keepId && !used.has(node.id)).map((node) => node.id));
}

function withoutRemoved(nodes: CanvasNodeData[], connections: CanvasConnection[], removedIds: Set<string>) {
    return {
        nodes: nodes.filter((node) => !removedIds.has(node.id)),
        connections: connections.filter((connection) => !removedIds.has(connection.fromNodeId) && !removedIds.has(connection.toNodeId)),
    };
}

export function applyGroupSelection(selectedIds: Set<string>, nodes: CanvasNodeData[], connections: CanvasConnection[], group: CanvasNodeData) {
    const members = collectGroupMemberNodes(selectedIds, nodes);
    if (members.length < 2) return null;
    const memberIds = new Set(members.map((node) => node.id));
    const flattenedGroupIds = selectedGroupIds(selectedIds, nodes);
    const updated = nodes.filter((node) => !flattenedGroupIds.has(node.id)).map((node) => (memberIds.has(node.id) ? { ...node, metadata: { ...node.metadata, groupId: group.id } } : node));
    const insertAt = updated.findIndex((node) => memberIds.has(node.id));
    const withGroup = insertAt < 0 ? [...updated, group] : [...updated.slice(0, insertAt), group, ...updated.slice(insertAt)];
    const next = withoutRemoved(withGroup, connections, new Set([...flattenedGroupIds, ...emptyGroupIds(withGroup, group.id)]));
    return { ...next, selectedIds: [group.id] };
}

export function applyUngroupSelection(selectedIds: Set<string>, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const flattenedGroupIds = selectedGroupIds(selectedIds, nodes);
    if (!flattenedGroupIds.size && !nodes.some((node) => selectedIds.has(node.id) && node.metadata?.groupId)) return null;
    const releasedIds = new Set<string>();
    const updated = nodes
        .filter((node) => !flattenedGroupIds.has(node.id))
        .map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            if (!flattenedGroupIds.has(groupId) && !selectedIds.has(node.id)) return node;
            releasedIds.add(node.id);
            return { ...node, metadata: { ...node.metadata, groupId: undefined } };
        });
    const next = withoutRemoved(updated, connections, new Set([...flattenedGroupIds, ...emptyGroupIds(updated)]));
    return { ...next, selectedIds: next.nodes.filter((node) => selectedIds.has(node.id) || releasedIds.has(node.id)).map((node) => node.id) };
}

export function findContainingGroupId(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    // Called once per moved node when a drag ends, so avoid copying the node list each time.
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const group = nodes[index];
        if (group.type === CanvasNodeType.Group && group.id !== node.id && containsCenter(group, node)) return group.id;
    }
    return undefined;
}

export function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

export function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    // Tables are a data source for generation configs and a sink for media/text inputs.
    // Normalize both drag directions so the stored edge always matches the data flow.
    const table = first.type === CanvasNodeType.Table ? first : second.type === CanvasNodeType.Table ? second : null;
    const config = first.type === CanvasNodeType.Config ? first : second.type === CanvasNodeType.Config ? second : null;
    if (table && config) return { fromNodeId: table.id, toNodeId: config.id };
    if (table) {
        const other = first.id === table.id ? second : first;
        if (first.id === table.id) {
            // Table output: an empty image node becomes the per-row generation target.
            if (other.type === CanvasNodeType.Image && !other.metadata?.content) return { fromNodeId: table.id, toNodeId: other.id };
            return null;
        }
        // Wired into the table as a connection-driven input row.
        if (other.type === CanvasNodeType.Image || other.type === CanvasNodeType.Text || other.type === CanvasNodeType.Group) return { fromNodeId: other.id, toNodeId: table.id };
        return null;
    }
    if (second.type === CanvasNodeType.Group) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}

export type FocusFrame = {
    // Screen-space room taken above/below the node by open overlays (hover toolbar, prompt panel), gaps included.
    above?: number;
    below?: number;
    // Fixed chrome covering the bottom edge of the canvas (dock), excluded from the usable area.
    bottomInset?: number;
};

// Viewport that centers the node (plus any open overlay above/below) in the usable canvas area, zoomed so the
// whole thing fits (the node itself is kept within 60% of the viewport). When an overlay is open below the node,
// the remaining space is split 3:1 so the panel sits closer to the bottom dock (half the usual bottom gap).
export function focusViewportForNode(node: Pick<CanvasNodeData, "position" | "width" | "height">, size: { width: number; height: number }, frame: FocusFrame = {}): ViewportTransform {
    const above = frame.above ?? 0;
    const below = frame.below ?? 0;
    const usableBottom = Math.max(0, size.height - (frame.bottomInset ?? 0));
    const nodeCenterX = node.position.x + node.width / 2;
    const nodeCenterY = node.position.y + node.height / 2;
    const verticalRoom = usableBottom * 0.92 - above - below;
    const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height, verticalRoom / node.height), 0.05), 1);
    const groupHeight = above + node.height * k + below;
    const slack = usableBottom - groupHeight;
    const groupTop = slack * (below > 0 && slack > 0 ? 0.75 : 0.5);
    return { x: size.width / 2 - nodeCenterX * k, y: groupTop + groupHeight / 2 - nodeCenterY * k - (below - above) / 2, k };
}
