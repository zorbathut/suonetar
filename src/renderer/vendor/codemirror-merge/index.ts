// Suonetar: the interfaces are re-exported as types, since Vite compiles one file at a time and would otherwise keep their names, which the browser then fails to link.
export {Change, diff, presentableDiff} from "./diff"
export type {DiffConfig} from "./diff"

export {getChunks, goToNextChunk, goToPreviousChunk} from "./merge"

export {MergeView} from "./mergeview"
export type {MergeConfig, DirectMergeConfig} from "./mergeview"

export {unifiedMergeView, acceptChunk, rejectChunk, getOriginalDoc,
        originalDocChangeEffect, updateOriginalDoc} from "./unified"

export {uncollapseUnchanged, mergeViewSiblings} from "./deco"

export {Chunk} from "./chunk"
