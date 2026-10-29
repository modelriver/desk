// Files picked or dropped from the computer, with the folders they sit in.
// A dropped folder only shows up through dataTransfer.items (its entry in
// dataTransfer.files is an empty stand-in), so folders are walked here.

import { MAX_PICKED } from './folder-upload.ts'

export interface PickedFile {
  // "Billing/Plans.md" for a file inside a picked or dropped folder.
  path: string
  file: File
}

const TOO_MANY = `That’s more than ${MAX_PICKED.toLocaleString('en-US')} files. Upload a smaller folder.`

// What was dropped. Call it inside the drop handler itself: the browser
// empties dataTransfer as soon as the handler returns or awaits.
export function droppedEntries(transfer: DataTransfer): FileSystemEntry[] {
  return [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null)
}

// Every file in the dropped entries, folders walked, hidden folders (.git)
// left out. Stops with an error past MAX_PICKED files.
export async function readDropped(entries: FileSystemEntry[]): Promise<PickedFile[]> {
  const out: PickedFile[] = []
  const visit = async (entry: FileSystemEntry, prefix: string) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isFile) {
      if (out.length >= MAX_PICKED) throw new Error(TOO_MANY)
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      out.push({ path, file })
    } else if (entry.isDirectory && !entry.name.startsWith('.')) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      // readEntries hands back at most 100 entries a call: read until it's empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!batch.length) break
        for (const child of batch) await visit(child, path)
      }
    }
  }
  for (const entry of entries) await visit(entry, '')
  return out
}

// The files from a folder picker (<input webkitdirectory>), which carry their
// path inside the picked folder. Files inside hidden folders (.git) are left
// out, as they are from a drop.
export function pickedFolder(files: FileList | File[]): PickedFile[] {
  const list = [...files]
    .map((file) => ({ path: file.webkitRelativePath || file.name, file }))
    .filter(({ path }) => !path.split('/').slice(0, -1).some((part) => part.startsWith('.')))
  if (list.length > MAX_PICKED) throw new Error(TOO_MANY)
  return list
}
