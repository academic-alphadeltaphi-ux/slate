export default function ConflictBanner({ conflict, onReload, onKeep }) {
  const what = conflict.kind === 'layout' ? 'The layout of this page' : 'This page'
  return (
    <div className="banner">
      <span>{what} changed on disk{conflict.external ? ' while you were editing' : ''}.</span>
      <button className="btn small" onClick={onReload}>Reload from disk</button>
      <button className="btn small primary" onClick={onKeep}>Keep mine</button>
    </div>
  )
}
