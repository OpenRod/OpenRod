import * as React from "react"

// Fixed-height windowing. A thousand workspaces is exactly the size where a
// naive map() still "works" in development and then stutters on a laptop with
// a browser full of tabs, so the prototype renders only what is on screen.
export function useVirtualRows({ count, rowHeight, overscan = 8 }) {
  // A callback ref, so a list that mounts later (after a view switch) is still measured.
  const [element, ref] = React.useState(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const [height, setHeight] = React.useState(0)

  React.useLayoutEffect(() => {
    if (!element) return
    const measure = () => setHeight(element.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visible = Math.ceil((height || 600) / rowHeight) + overscan * 2
  const end = Math.min(count, start + visible)

  return {
    ref,
    onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
    start,
    end,
    paddingTop: start * rowHeight,
    totalHeight: count * rowHeight,
    scrollToTop: () => {
      element?.scrollTo({ top: 0 })
      setScrollTop(0)
    },
  }
}
