import type { KeyboardEvent, PointerEvent } from 'react'

export function VerticalResizeHandle(props: {
  readonly ariaLabel: string
  readonly className: string
  readonly onDelta: (delta: number) => void
}) {
  const pointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.dataset.dragX = String(event.clientX)
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const previous = Number(event.currentTarget.dataset.dragX)
    if (!Number.isFinite(previous)) return
    const delta = event.clientX - previous
    if (delta === 0) return
    event.currentTarget.dataset.dragX = String(event.clientX)
    props.onDelta(delta)
  }
  const pointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    delete event.currentTarget.dataset.dragX
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    props.onDelta(event.key === 'ArrowLeft' ? -16 : 16)
  }
  return <div role="separator" aria-label={props.ariaLabel} aria-orientation="vertical" tabIndex={0}
    className={props.className} onPointerDown={pointerDown} onPointerMove={pointerMove}
    onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onKeyDown={keyDown} />
}
