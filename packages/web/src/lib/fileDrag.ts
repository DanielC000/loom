import type { DragEvent } from "react";

// A file dropped on a page region that doesn't cancel the drop makes the browser's default apply:
// Chrome opens the file in the tab, navigating away from Loom. Cancel dragover + drop for FILE drags
// only (DataTransfer.types contains "Files"); a text/link drag is left alone so selecting-and-dragging
// text keeps working. This deliberately does NOT read, upload or insert the dropped file.
export function isFileDrag(e: Pick<DragEvent, "dataTransfer">): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes("Files");
}

export function swallowFileDrag(e: DragEvent): void {
  if (isFileDrag(e)) e.preventDefault();
}

/** Spread onto the root element of a surface that must not navigate away on a dropped file. */
export const fileDropGuardProps = { onDragOver: swallowFileDrag, onDrop: swallowFileDrag };
