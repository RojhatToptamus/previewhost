export function LandingTabs<T extends string>({ id, label, items, selected, onSelect }: {
  id: string; label: string; items: readonly { id: T; label: string }[]; selected: T; onSelect: (id: T) => void;
}) {
  return <div className="landing-tabs" role="tablist" aria-label={label} onKeyDown={event => {
    const current = items.findIndex(item => item.id === selected);
    const next = event.key === "ArrowRight" ? (current + 1) % items.length
      : event.key === "ArrowLeft" ? (current + items.length - 1) % items.length
        : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (next === -1) return;
    event.preventDefault();
    onSelect(items[next].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }}>
    {items.map(item => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}`}
      aria-controls={`${id}-panel`} aria-selected={selected === item.id} tabIndex={selected === item.id ? 0 : -1}
      onClick={() => onSelect(item.id)}>{item.label}</button>)}
  </div>;
}
