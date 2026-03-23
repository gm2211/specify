import type { StatusFilter } from '../types';

interface SearchBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  statusFilter: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
  tagFilter: string[];
  onTagChange: (tags: string[]) => void;
  allTags: string[];
}

export default function SearchBar({
  searchText,
  onSearchChange,
  statusFilter,
  onStatusChange,
  tagFilter,
  onTagChange,
  allTags,
}: SearchBarProps) {
  const toggleTag = (tag: string) => {
    if (tagFilter.includes(tag)) {
      onTagChange(tagFilter.filter((t) => t !== tag));
    } else {
      onTagChange([...tagFilter, tag]);
    }
  };

  return (
    <div className="search-bar">
      <div className="search-bar-row">
        <div className="search-input-wrapper">
          <svg className="search-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04Z" />
          </svg>
          <input
            type="text"
            className="search-input"
            placeholder="Search behaviors..."
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {searchText && (
            <button className="search-clear" onClick={() => onSearchChange('')}>
              &times;
            </button>
          )}
        </div>
        <select
          className="status-select"
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value as StatusFilter)}
        >
          <option value="all">All statuses</option>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
          <option value="untested">Untested</option>
        </select>
      </div>
      {allTags.length > 0 && (
        <div className="tag-chips">
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`tag-chip ${tagFilter.includes(tag) ? 'tag-chip--active' : ''}`}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
