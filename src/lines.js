export function createLineDecoder(onLine) {
  let buffer = ''
  return {
    write(chunk) {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) onLine(line)
      }
    },
    end() {
      if (buffer.trim()) onLine(buffer)
      buffer = ''
    },
  }
}
