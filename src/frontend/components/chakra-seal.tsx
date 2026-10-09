export function ChakraSeal({ active = false, complete = false, className = '' }: {
  active?: boolean;
  complete?: boolean;
  className?: string;
}) {
  return (
    <span className={`chakra-seal ${className}`} data-active={active} data-complete={complete} aria-hidden="true">
      <svg className="chakra-seal-svg size-full" viewBox="0 0 160 160" fill="none">
        <g className="chakra-orbit-outer" stroke="currentColor" strokeWidth="1">
          <circle cx="80" cy="80" r="73" opacity=".3" />
          <circle cx="80" cy="80" r="68" strokeDasharray="38 8 2 8" />
          {[0, 60, 120, 180, 240, 300].map(angle => (
            <path key={angle} d="M80 4v13m-3-10h6" transform={`rotate(${angle} 80 80)`} />
          ))}
        </g>
        <g className="chakra-orbit-inner" stroke="currentColor" strokeWidth="1.5">
          <circle cx="80" cy="80" r="56" strokeDasharray="64 24" />
          <path d="M80 29l44 26v50l-44 26-44-26V55z" opacity=".25" />
        </g>
        <circle cx="80" cy="80" r="36" stroke="currentColor" opacity=".2" />
        <path className="chakra-leaf" d="M74 83c0-7 10-10 16-4 7 7 1 19-10 19-14 0-24-12-21-25 3-14 20-21 34-13l22-10-6 26c4 19-10 34-30 34H49l13-16"
          stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path className="chakra-check" d="m63 80 12 12 24-24" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
