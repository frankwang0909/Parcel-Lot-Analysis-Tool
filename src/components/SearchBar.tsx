import { useState, useEffect, useRef } from "react"
import type { KeyboardEvent } from "react"
import "./SearchBar.css"

interface SearchResult {
  id: string
  place_name: string
  center: [number, number]
}

interface SearchBarProps {
  onSelectResult: (result: SearchResult) => void
}

const HISTORY_KEY = "search-history"
const MAX_HISTORY = 10
const MAX_QUERY_LENGTH = 120

export default function SearchBar({ onSelectResult }: SearchBarProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [history, setHistory] = useState<SearchResult[]>(() => {
    const stored = localStorage.getItem(HISTORY_KEY)
    if (stored) {
      try {
        return JSON.parse(stored)
      } catch {
        return []
      }
    }
    return []
  })
  const [isOpen, setIsOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const trimmedQuery = query.trim()
    
    if (!trimmedQuery) {
      const timer = setTimeout(() => {
        setResults([])
      }, 0)
      return () => clearTimeout(timer)
    }

    if (trimmedQuery.length > MAX_QUERY_LENGTH) {
      const timer = setTimeout(() => {
        setResults([])
        setSelectedIndex(-1)
      }, 0)
      return () => clearTimeout(timer)
    }

    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
            trimmedQuery
          )}.json?access_token=${
            import.meta.env.VITE_MAPBOX_TOKEN
          }&country=ca&bbox=-123.3,49.2,-123.0,49.35&types=address&limit=8`
        )
        if (!res.ok) {
          setResults([])
          setSelectedIndex(-1)
          return
        }
        const data = await res.json()
        setResults(data.features || [])
        setSelectedIndex(-1)
      } catch {
        setResults([])
        setSelectedIndex(-1)
      }
    }, 300)

    return () => clearTimeout(timeout)
  }, [query])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const handleSelectResult = (result: SearchResult) => {
    const newHistory = [
      result,
      ...history.filter((h) => h.id !== result.id),
    ].slice(0, MAX_HISTORY)
    setHistory(newHistory)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory))

    setQuery("")
    setResults([])
    setIsOpen(false)
    setSelectedIndex(-1)

    onSelectResult(result)
  }

  const handleClearHistory = () => {
    setHistory([])
    localStorage.removeItem(HISTORY_KEY)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const currentList = query.trim() ? results : history
    const maxIndex = currentList.length - 1

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setSelectedIndex((prev) => (prev < maxIndex ? prev + 1 : 0))
        break
      case "ArrowUp":
        e.preventDefault()
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : maxIndex))
        break
      case "Enter":
        e.preventDefault()
        if (selectedIndex >= 0 && selectedIndex < currentList.length) {
          handleSelectResult(currentList[selectedIndex])
        }
        break
      case "Escape":
        e.preventDefault()
        setIsOpen(false)
        setSelectedIndex(-1)
        inputRef.current?.blur()
        break
    }
  }

  const displayList = query.trim() ? results : history
  const showDropdown = isOpen && (displayList.length > 0 || (!query.trim() && history.length > 0))

  return (
    <div className="search-bar-container">
      <div className="search-input-wrapper">
        <input
          ref={inputRef}
          type="text"
          className="search-input"
          placeholder="Search address in Vancouver..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {query && (
          <button
            className="search-clear-button"
            onClick={() => {
              setQuery("")
              setResults([])
              inputRef.current?.focus()
            }}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {showDropdown && (
        <div ref={dropdownRef} className="search-dropdown">
          {!query.trim() && history.length > 0 && (
            <div className="search-dropdown-header">
              <span className="search-dropdown-title">Recent Searches</span>
              <button
                className="search-clear-history-button"
                onClick={handleClearHistory}
              >
                Clear history
              </button>
            </div>
          )}

          <ul className="search-results-list">
            {displayList.map((result, index) => (
              <li
                key={result.id}
                className={`search-result-item ${
                  index === selectedIndex ? "selected" : ""
                }`}
                onClick={() => handleSelectResult(result)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="search-result-icon">📍</span>
                <span className="search-result-text">{result.place_name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
