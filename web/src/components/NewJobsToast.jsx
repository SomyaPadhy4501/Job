export default function NewJobsToast({ count, onClick }) {
  return (
    <button type="button" className="toast" onClick={onClick}>
      <span className="toast-dot" aria-hidden="true" />
      {count.toLocaleString()} new job{count === 1 ? '' : 's'} · click to add
    </button>
  );
}
