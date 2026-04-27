import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FaviconImage } from "@/components/ui/favicon-image";

const SEARCH_ENGINES = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q=", siteUrl: "https://www.google.com" },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=", siteUrl: "https://www.bing.com" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=", siteUrl: "https://duckduckgo.com" },
  { id: "baidu", name: "Baidu", url: "https://www.baidu.com/s?wd=", siteUrl: "https://www.baidu.com" },
  { id: "yahoo", name: "Yahoo", url: "https://search.yahoo.com/search?p=", siteUrl: "https://www.yahoo.com" },
  { id: "yandex", name: "Yandex", url: "https://yandex.com/search/?text=", siteUrl: "https://yandex.com" },
  { id: "ecosia", name: "Ecosia", url: "https://www.ecosia.org/search?q=", siteUrl: "https://www.ecosia.org" },
  { id: "kagi", name: "Kagi", url: "https://kagi.com/search?q=", siteUrl: "https://kagi.com" },
  { id: "github", name: "GitHub", url: "https://github.com/search?q=", siteUrl: "https://github.com" },
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/results?search_query=", siteUrl: "https://www.youtube.com" },
];

const SHORTCUTS = [
  { name: "GitHub", url: "https://github.com" },
  { name: "YouTube", url: "https://youtube.com" },
  { name: "Twitter", url: "https://twitter.com" },
  { name: "LinkedIn", url: "https://linkedin.com" },
  { name: "Reddit", url: "https://reddit.com" },
  { name: "Product Hunt", url: "https://producthunt.com" },
  { name: "Hacker News", url: "https://news.ycombinator.com" },
];

function getFaviconUrl(pageUrl: string, size: number = 64) {
  try {
    // Try to use Chrome's native favicon API if available (requires "favicon" permission)
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      const urlObj = new URL(chrome.runtime.getURL("/_favicon/"));
      urlObj.searchParams.set("pageUrl", pageUrl);
      urlObj.searchParams.set("size", size.toString());
      return urlObj.toString();
    }
  } catch (e) {
    // Fallback
  }
  // Fallback to DuckDuckGo's reliable favicon service
  try {
    const domain = new URL(pageUrl).hostname;
    return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  } catch {
    return "";
  }
}

export function HeroSection() {
  const [time, setTime] = React.useState(new Date());
  const [query, setQuery] = React.useState("");
  const [engine, setEngine] = React.useState(SEARCH_ENGINES[0]);

  React.useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      window.location.href = `${engine.url}${encodeURIComponent(query.trim())}`;
    }
  };

  const formattedTime = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const formattedDate = time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();

  return (
    <div className="flex flex-col items-center justify-center py-10 md:py-16 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="text-center space-y-2">
        <h1 className="text-6xl md:text-8xl font-bold tracking-tighter text-foreground">
          {formattedTime}
        </h1>
        <p className="text-sm md:text-base font-medium text-muted-foreground tracking-widest">
          {formattedDate}
        </p>
      </div>

      <div className="w-full max-w-2xl px-4">
        <form onSubmit={handleSearch} className="relative flex items-center w-full group">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button 
                variant="ghost" 
                size="icon" 
                className="absolute left-1 z-10 size-12 rounded-full hover:bg-muted focus-visible:ring-0"
                type="button"
              >
                <img src={getFaviconUrl(engine.siteUrl, 32)} alt={engine.name} className="size-5 rounded-sm" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[150px] max-h-[300px] overflow-y-auto">
              {SEARCH_ENGINES.map((e) => (
                <DropdownMenuItem key={e.id} onClick={() => setEngine(e)} className="cursor-pointer">
                  <img src={getFaviconUrl(e.siteUrl, 32)} alt={e.name} className="size-4 mr-2 rounded-sm" />
                  {e.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Input
            type="text"
            placeholder={`Search with ${engine.name}...`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full h-14 pl-14 pr-14 rounded-full bg-background/60 backdrop-blur-md border-muted/60 shadow-sm text-lg focus-visible:ring-1 focus-visible:ring-primary/50 transition-all"
          />

          <Button 
            type="submit" 
            variant="ghost" 
            size="icon" 
            className="absolute right-1 z-10 size-12 rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-0"
          >
            <Search className="size-5" />
          </Button>
        </form>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-4 max-w-3xl px-4">
        {SHORTCUTS.map((shortcut) => (
          <a
            key={shortcut.name}
            href={shortcut.url}
            className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-muted/50 transition-colors group min-w-[80px]"
          >
            <div className="size-12 rounded-full bg-background/80 shadow-sm border border-muted/50 flex items-center justify-center group-hover:shadow-md transition-all group-hover:scale-105 overflow-hidden">
              <FaviconImage src={getFaviconUrl(shortcut.url, 64)} className="size-6" />
            </div>
            <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
              {shortcut.name}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
