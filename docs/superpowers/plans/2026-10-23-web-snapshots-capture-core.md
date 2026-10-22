# Web Snapshots Capture Core Implementation Plan (Sub-project C2-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side capture core for web snapshots. It has network access that reaches only public addresses, a CDP client that renders pages in obscura, and a capture package. That package turns a URL into a reader version, a screenshot, and a cover copy, or keeps an image or PDF as it is, or saves a full-page archive, and it gives every failure a reason code.

**Architecture:** Three new packages in TabSlate-server, none of which read configuration, touch the database, call the API, or enqueue jobs:
- `internal/netguard`: a dialer guarded against SSRF, the worker's HTTP client, and an egress proxy.
- `internal/browser`: a minimal CDP client and page renderer that use only the methods obscura documents.
- `internal/snapshots/capture`: preflight, rendering, reader extraction, images, monolith archives, and failure classification.

C2-2 wires them into the `cmd/fetcher` worker, storage, and the API.

**Tech Stack:** Go 1.25, `github.com/coder/websocket`, `code.dny.dev/ssrf`, `github.com/elazarl/goproxy`, `codeberg.org/readeck/go-readability/v2`, `github.com/microcosm-cc/bluemonday`, `golang.org/x/image`, and `golang.org/x/net/html`. obscura runs in Docker for the integration check. monolith is an external binary, faked in the tests.

**Spec:** `docs/superpowers/specs/2026-10-21-web-snapshots-design.md` (in the TabSlate repository). This plan covers section 1's capture components, section 3, the failure codes that section 11 relies on, and the capture items of the Testing section. It is plan 1 of 5 for C2:
1. C2-1 capture core (this plan).
2. C2-2 server snapshot service.
3. C2-3 Cloud.
4. C2-4 extension.
5. C2-5 browser capture.

## Global Constraints

- **Repository and branch.** All code is in `/Users/lieutenant/Documents/github/TabSlate-server`. Create the branch `feat/web-snapshots` from `feat/bookmark-cover` (C1's server branch, at `d6b4c8f`). All C2 server plans continue on this branch. Do not push, open pull requests, or use git worktrees.
- **Commits.** Stage files by path. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Go version.** `go.mod` keeps `go 1.25.0` and gets no `toolchain` line, because the Dockerfile builds with `golang:1.25-alpine`. Run every Go command with `GOTOOLCHAIN=local`. The local toolchain may be newer; the module's `go` line is what counts.
- **Dependencies.** Add exactly these versions:
  - `github.com/coder/websocket v1.8.15`
  - `code.dny.dev/ssrf v0.3.0`
  - `github.com/elazarl/goproxy v1.9.2`
  - `codeberg.org/readeck/go-readability/v2 v2.1.3`
  - `github.com/microcosm-cc/bluemonday v1.0.27`
  - `golang.org/x/image v0.38.0`

  Newer `golang.org/x/image` and `golang.org/x/net` releases need Go 1.26, so `golang.org/x/net` stays at the server's v0.53.0. After every `go get` and `go mod tidy`, `git diff go.mod` may show only `require` changes. If the `go` line changes or a `toolchain` line appears, run `git checkout go.mod go.sum` and report.
- **Server conventions.** Use the standard `testing` package, with `t.Context()`, `t.Fatalf`, and `t.Errorf`. CI runs `go build ./...`, `go vet ./...`, and `go test ./...`, and all three must pass.
- **Spec limits (section 3), copied exactly:**
  - Preflight reads only the headers, and an HTML page whose declared size is over 5 MB fails with `too_large`.
  - An image or PDF of at most 20 MB is the snapshot itself, and the browser is not used.
  - Video, audio, archives, installers, `Content-Disposition: attachment`, and other types are `unsupported`.
  - The worker's own requests follow at most 5 redirects and accept only `http` and `https` URLs without embedded credentials.
  - Time limits: 15 seconds for navigation, 10 seconds for page scripts, and 30 seconds for the whole job.
  - The viewport is 1280×800, and screenshots cover the viewport only.
  - Video, audio, and font requests fail, and a page stops after 300 sub-requests or 25 MB transferred.
  - The reader version is at most 2 MB.
  - The screenshot is a JPEG, quality 80.
  - The cover copy is at most 5 MB of `image/*`, with the pixel count checked before decoding, scaled to 640 px wide, and stored as a JPEG.
  - The archive is made by monolith `-I -j -e` with the final URL as the base, through a local proxy that dials only through the SSRF-protected dialer. An archive over 20 MB is discarded.
  - At most 2 concurrent requests go to one site.
  - Timeouts, 5xx and 429 responses, and a busy browser are retryable.
- **Reason codes.** `timeout`, `blocked`, `dns_error`, `connect_error`, `tls_error`, `http_error` (with the status), `too_large`, `unsupported`, `render_error`, and `fetch_error`. `storage_full` belongs to C2-2, which decides it when saving.

## Notes on the Spec

1. **Our own CDP client.** obscura accepts its token only as an `Authorization: Bearer` header and documents only part of CDP. chromedp's API changed (v0.20 moved remote connections into a `remote` package with generic actions), and its target setup enables CDP domains that obscura does not list. The plan therefore uses a small client on `coder/websocket`. It sends only these methods:
   - `Target.createBrowserContext`, `Target.createTarget`, `Target.attachToTarget`, and `Target.disposeBrowserContext`;
   - `Page.enable`, `Page.navigate`, `Page.getFrameTree`, and `Page.captureScreenshot`;
   - `Network.enable`;
   - `Fetch.enable`, `Fetch.continueRequest`, and `Fetch.failRequest`;
   - `Runtime.evaluate`;
   - `Emulation.setDeviceMetricsOverride`, whose "method not found" error is tolerated because `Target.createTarget` already asks for 1280×800.
2. **The obscura check comes third.** The spec makes it the first task, but it needs the CDP client and the renderer, so it is Task 3: right after them and before anything else. Its stop conditions keep later tasks from building on a browser that does not work.
3. **Load detection.** obscura does not document lifecycle events, so the renderer polls `document.readyState` instead. It waits until the navigated document is interactive, within 15 s, and then until it is complete and quiet for 1 s, within 10 s.
4. **Byte limit.** The 25 MB limit counts `Network.loadingFinished` sizes. If obscura does not send that event, the time limits bound the work, as the spec allows.
5. **HTTP status.** A capture uses the status the browser reported for the main document, and falls back to the preflight's status when the browser reports none.
6. **Reason codes.** The codes above extend the spec's examples:
   - `tls_error` exists because the spec excludes TLS errors from "possibly broken".
   - `render_error` and `fetch_error` cover everything else.
   - `unsupported` is a failure reason here; C2-2 stores it as the `unsupported` status.
7. **Long reader versions.** A reader version over 2 MB is dropped rather than cut.
8. **monolith settings.** monolith also gets:
   - `-a -v`, which exclude audio and video, matching the spec's non-goal of saving videos;
   - `-q`, which silences its progress output.

   Its environment holds only the proxy variables, so the subprocess never sees server secrets. Archives get 60 s, since the spec sets no limit for them.
9. **Screenshots.** obscura documents only PNG output, so screenshots are always re-encoded as JPEG. A larger capture is cropped to 1280×800 from the top left.
10. **Per-site limit.** The limit of 2 applies to whole jobs. The browser's own sub-requests cannot be limited per site.
11. **Missing Content-Type.** When a response has no `Content-Type`, the preflight sniffs its first 512 bytes.
12. **Empty pages.** A page capture succeeds only when it keeps a reader version or a screenshot. Otherwise it fails with `render_error`.

## File Structure

`internal/browser/`
- `cdp.go`: `Dial`, `Conn` (commands with ids, flattened sessions), `Inbox` (an unbounded per-session event queue), `CallError`, `ErrClosed`.
- `render.go`: `Browser.Render`, `Limits`, `Page`, `ErrUnavailable`, `ErrTimeout`, `NavigationError`; the request watch that answers `Fetch.requestPaused`.
- `fake_test.go`: a scriptable fake CDP WebSocket server.
- `cdp_test.go`, `render_test.go` (the latter includes the simulated page).
- `obscura_integration_test.go`: `//go:build integration`; the check against a real obscura.

`internal/netguard/`
- `guard.go`: `Guard` (SSRF-guarded dialer), `Client`, `ValidateURL`, `IsBlocked`, `UserAgent`.
- `proxy.go`: `EgressProxy` for monolith.
- `guard_test.go`, `proxy_test.go`.

`internal/snapshots/capture/`
- `reader.go`: `ExtractReader`, `CoverURL`.
- `images.go`: `FetchCover`, `NormalizeScreenshot`, `readLimited`, `mediaTypeOf`.
- `capture.go`: result types, `Config`, `Capturer`, `Capture`, the per-host limiter.
- `failure.go`: `Reason`, `Failure`, and error classification.
- `preflight.go`: the header-only preflight.
- `archive.go`: `Archive` and the monolith runner.
- `fixtures_test.go`, `reader_test.go`, `images_test.go`, `capture_test.go`, `archive_test.go`.

Docs: `CLAUDE.md` (package table) and `ARCHITECTURE.md` (directory tree).

## Prerequisites

- Network access for `go get`.
- `/bin/sh`, `cat` and `head` for the fake monolith in Task 9.
- Docker for Task 3 (OrbStack on this machine; if `docker info` fails, ask the user to start it).

---

### Task 1: CDP client

**Files:**
- Create: `internal/browser/fake_test.go`, `internal/browser/cdp_test.go`, `internal/browser/cdp.go`

**Interfaces:**
- Produces:
  - `browser.Dial(ctx context.Context, wsURL, token string) (*Conn, error)`: sends `Authorization: Bearer <token>` when `token` is not empty.
  - `(*Conn).Call(ctx context.Context, sessionID, method string, params, result any) error`: an empty `sessionID` addresses the browser, and `result` may be nil.
  - `(*Conn).Events(sessionID string) *Inbox`, `(*Inbox).Next(ctx context.Context) (Event, error)`, `(*Conn).Close() error`.
  - `Event{SessionID, Method string; Params json.RawMessage}`, `*CallError{Method string; Code int; Message string}`, `ErrClosed`.
  - Test helpers for Task 2: `newFakeCDP(t, token, handle func(fakeCall) fakeReply) *fakeCDP`, `fakeCall.param(key) any`, `(*fakeCDP).URL()`, `(*fakeCDP).Calls(method)`, `fakeReply{Events, Result, ErrCode, ErrMsg, NoReply, Close}`, `fakeEvent{SessionID, Method, Params}`.

- [ ] **Step 1: Create the branch and add the WebSocket library**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git switch -c feat/web-snapshots feat/bookmark-cover
GOTOOLCHAIN=local go get github.com/coder/websocket@v1.8.15
git diff go.mod
```

Expected: one new `require` line for `github.com/coder/websocket v1.8.15`, and `go 1.25.0` unchanged.

- [ ] **Step 2: Write the fake CDP server**

Create `internal/browser/fake_test.go`:

```go
package browser

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/coder/websocket"
)

// fakeCall is one command the fake CDP server received.
type fakeCall struct {
	Method    string
	SessionID string
	Params    json.RawMessage
}

func (c fakeCall) param(key string) any {
	var params map[string]any
	_ = json.Unmarshal(c.Params, &params)
	return params[key]
}

type fakeEvent struct {
	SessionID string
	Method    string
	Params    any
}

// fakeReply is what the fake sends for a command: events first, then the
// result or error, or nothing at all when NoReply is set.
type fakeReply struct {
	Events  []fakeEvent
	Result  any
	ErrCode int
	ErrMsg  string
	NoReply bool
	// Close closes the connection instead of replying.
	Close bool
}

// fakeCDP is a CDP WebSocket server that answers with a test's handler.
type fakeCDP struct {
	server *httptest.Server
	mu     sync.Mutex
	calls  []fakeCall
}

func newFakeCDP(t *testing.T, token string, handle func(fakeCall) fakeReply) *fakeCDP {
	t.Helper()
	fake := &fakeCDP{}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token != "" && r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		ws.SetReadLimit(maxMessageBytes)
		ctx := context.Background()
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var request struct {
				ID        int64           `json:"id"`
				Method    string          `json:"method"`
				Params    json.RawMessage `json:"params"`
				SessionID string          `json:"sessionId"`
			}
			if json.Unmarshal(data, &request) != nil {
				return
			}
			call := fakeCall{Method: request.Method, SessionID: request.SessionID, Params: request.Params}
			fake.mu.Lock()
			fake.calls = append(fake.calls, call)
			fake.mu.Unlock()
			reply := handle(call)
			for _, event := range reply.Events {
				message := map[string]any{"method": event.Method, "params": event.Params}
				if event.SessionID != "" {
					message["sessionId"] = event.SessionID
				}
				if writeJSON(ctx, ws, message) != nil {
					return
				}
			}
			if reply.Close {
				ws.Close(websocket.StatusNormalClosure, "")
				return
			}
			if reply.NoReply {
				continue
			}
			response := map[string]any{"id": request.ID}
			if reply.ErrMsg != "" {
				response["error"] = map[string]any{"code": reply.ErrCode, "message": reply.ErrMsg}
			} else if reply.Result != nil {
				response["result"] = reply.Result
			} else {
				response["result"] = map[string]any{}
			}
			if writeJSON(ctx, ws, response) != nil {
				return
			}
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func writeJSON(ctx context.Context, ws *websocket.Conn, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return ws.Write(ctx, websocket.MessageText, data)
}

func (f *fakeCDP) URL() string {
	return "ws" + strings.TrimPrefix(f.server.URL, "http") + "/devtools/browser"
}

func (f *fakeCDP) Calls(method string) []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var matching []fakeCall
	for _, call := range f.calls {
		if call.Method == method {
			matching = append(matching, call)
		}
	}
	return matching
}
```

- [ ] **Step 3: Write the failing client tests**

Create `internal/browser/cdp_test.go`:

```go
package browser

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCallSendsTheTokenAndDecodesResults(t *testing.T) {
	fake := newFakeCDP(t, "secret-token", func(call fakeCall) fakeReply {
		return fakeReply{Result: map[string]any{"echo": call.param("value"), "session": call.SessionID}}
	})
	conn, err := Dial(t.Context(), fake.URL(), "secret-token")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	var result struct {
		Echo    string `json:"echo"`
		Session string `json:"session"`
	}
	if err := conn.Call(t.Context(), "session-9", "Test.echo", map[string]any{"value": "hello"}, &result); err != nil {
		t.Fatalf("Call: %v", err)
	}
	if result.Echo != "hello" || result.Session != "session-9" {
		t.Fatalf("result = %+v, want the echoed value and session", result)
	}
}

func TestDialFailsWithAWrongToken(t *testing.T) {
	fake := newFakeCDP(t, "secret-token", func(fakeCall) fakeReply { return fakeReply{} })
	if _, err := Dial(t.Context(), fake.URL(), "other-token"); err == nil {
		t.Fatal("Dial with a wrong token succeeded")
	}
}

func TestCallReturnsBrowserErrors(t *testing.T) {
	fake := newFakeCDP(t, "", func(fakeCall) fakeReply {
		return fakeReply{ErrCode: -32601, ErrMsg: "method not found"}
	})
	conn, err := Dial(t.Context(), fake.URL(), "")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	err = conn.Call(t.Context(), "", "Missing.method", nil, nil)

	var callErr *CallError
	if !errors.As(err, &callErr) || callErr.Code != -32601 || callErr.Method != "Missing.method" {
		t.Fatalf("Call = %v, want a CallError for Missing.method", err)
	}
}

func TestEventsReachOnlyTheirSessionInOrder(t *testing.T) {
	fake := newFakeCDP(t, "", func(call fakeCall) fakeReply {
		if call.Method != "Test.emit" {
			return fakeReply{}
		}
		return fakeReply{Events: []fakeEvent{
			{SessionID: "a", Method: "Test.first"},
			{SessionID: "b", Method: "Test.elsewhere"},
			{SessionID: "a", Method: "Test.second"},
		}}
	})
	conn, err := Dial(t.Context(), fake.URL(), "")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()
	inbox := conn.Events("a")

	if err := conn.Call(t.Context(), "", "Test.emit", nil, nil); err != nil {
		t.Fatalf("Call: %v", err)
	}

	for _, want := range []string{"Test.first", "Test.second"} {
		event, err := inbox.Next(t.Context())
		if err != nil || event.Method != want {
			t.Fatalf("Next = %q, %v; want %q", event.Method, err, want)
		}
	}
}

func TestCallStopsWithItsContext(t *testing.T) {
	fake := newFakeCDP(t, "", func(fakeCall) fakeReply { return fakeReply{NoReply: true} })
	conn, err := Dial(t.Context(), fake.URL(), "")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()

	if err := conn.Call(ctx, "", "Test.never", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Call = %v, want context.DeadlineExceeded", err)
	}
}

func TestClosedConnectionEndsCallsAndEvents(t *testing.T) {
	fake := newFakeCDP(t, "", func(call fakeCall) fakeReply {
		return fakeReply{Close: call.Method == "Test.close"}
	})
	conn, err := Dial(t.Context(), fake.URL(), "")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	inbox := conn.Events("a")

	if err := conn.Call(t.Context(), "", "Test.close", nil, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("Call = %v, want ErrClosed", err)
	}
	if _, err := inbox.Next(t.Context()); !errors.Is(err, ErrClosed) {
		t.Fatalf("Next = %v, want ErrClosed", err)
	}
	if err := conn.Call(t.Context(), "", "Test.after", nil, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("Call after closing = %v, want ErrClosed", err)
	}
}
```

- [ ] **Step 4: Run them to verify they fail**

Run: `GOTOOLCHAIN=local go test ./internal/browser/`
Expected: FAIL to compile with `undefined: Dial`, `undefined: maxMessageBytes`, and `undefined: CallError`.

- [ ] **Step 5: Implement the client**

Create `internal/browser/cdp.go`:

```go
// Package browser renders pages in a headless browser over the Chrome
// DevTools Protocol (CDP). It targets obscura and uses only the CDP methods
// obscura documents, so a headless Chrome endpoint works as well.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
)

// maxMessageBytes bounds one CDP message; screenshots and page HTML arrive as single messages.
const maxMessageBytes = 64 << 20

// ErrClosed is returned once the connection has closed.
var ErrClosed = errors.New("cdp: connection closed")

// CallError is an error the browser returned for a command.
type CallError struct {
	Method  string
	Code    int
	Message string
}

func (e *CallError) Error() string {
	return fmt.Sprintf("cdp %s: %s (%d)", e.Method, e.Message, e.Code)
}

// Event is a CDP event. SessionID is empty for browser-level events.
type Event struct {
	SessionID string
	Method    string
	Params    json.RawMessage
}

type message struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// Conn is one CDP WebSocket connection. Its methods are safe for concurrent use.
type Conn struct {
	ws      *websocket.Conn
	nextID  atomic.Int64
	writeMu sync.Mutex

	mu      sync.Mutex
	pending map[int64]chan message
	inboxes map[string]*Inbox
	done    chan struct{}
}

// Dial connects to a CDP WebSocket endpoint, sending token as a bearer token when it is set.
func Dial(ctx context.Context, wsURL, token string) (*Conn, error) {
	header := http.Header{}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	ws, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, fmt.Errorf("cdp dial: %w", err)
	}
	ws.SetReadLimit(maxMessageBytes)
	conn := &Conn{
		ws:      ws,
		pending: map[int64]chan message{},
		inboxes: map[string]*Inbox{},
		done:    make(chan struct{}),
	}
	go conn.readLoop()
	return conn, nil
}

func (c *Conn) readLoop() {
	for {
		_, data, err := c.ws.Read(context.Background())
		if err != nil {
			break
		}
		var msg message
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		c.mu.Lock()
		if msg.ID != 0 {
			reply, ok := c.pending[msg.ID]
			delete(c.pending, msg.ID)
			c.mu.Unlock()
			if ok {
				reply <- msg
			}
			continue
		}
		inbox := c.inboxes[msg.SessionID]
		c.mu.Unlock()
		if inbox != nil {
			inbox.push(Event{SessionID: msg.SessionID, Method: msg.Method, Params: msg.Params})
		}
	}
	c.mu.Lock()
	close(c.done)
	for _, inbox := range c.inboxes {
		inbox.close()
	}
	c.mu.Unlock()
}

// Call sends a command and decodes its result into result, which may be nil.
// An empty sessionID addresses the browser itself.
func (c *Conn) Call(ctx context.Context, sessionID, method string, params, result any) error {
	msg := message{ID: c.nextID.Add(1), Method: method, SessionID: sessionID}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return fmt.Errorf("cdp %s: encode params: %w", method, err)
		}
		msg.Params = raw
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("cdp %s: encode: %w", method, err)
	}
	reply := make(chan message, 1)
	c.mu.Lock()
	select {
	case <-c.done:
		c.mu.Unlock()
		return ErrClosed
	default:
	}
	c.pending[msg.ID] = reply
	c.mu.Unlock()

	c.writeMu.Lock()
	err = c.ws.Write(ctx, websocket.MessageText, data)
	c.writeMu.Unlock()
	if err != nil {
		c.forget(msg.ID)
		return fmt.Errorf("cdp %s: %w", method, err)
	}
	select {
	case <-ctx.Done():
		c.forget(msg.ID)
		return ctx.Err()
	case <-c.done:
		return ErrClosed
	case response := <-reply:
		if response.Error != nil {
			return &CallError{Method: method, Code: response.Error.Code, Message: response.Error.Message}
		}
		if result == nil || len(response.Result) == 0 {
			return nil
		}
		if err := json.Unmarshal(response.Result, result); err != nil {
			return fmt.Errorf("cdp %s: decode result: %w", method, err)
		}
		return nil
	}
}

func (c *Conn) forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// Events returns the inbox that receives a session's events from now on.
func (c *Conn) Events(sessionID string) *Inbox {
	inbox := &Inbox{signal: make(chan struct{}, 1)}
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.done:
		inbox.closed = true
	default:
		c.inboxes[sessionID] = inbox
	}
	return inbox
}

// Close closes the connection.
func (c *Conn) Close() error {
	return c.ws.CloseNow()
}

// Inbox queues one session's events without ever blocking the connection's reader.
type Inbox struct {
	mu     sync.Mutex
	queue  []Event
	closed bool
	signal chan struct{}
}

func (in *Inbox) push(event Event) {
	in.mu.Lock()
	if !in.closed {
		in.queue = append(in.queue, event)
	}
	in.mu.Unlock()
	in.wake()
}

func (in *Inbox) close() {
	in.mu.Lock()
	in.closed = true
	in.mu.Unlock()
	in.wake()
}

func (in *Inbox) wake() {
	select {
	case in.signal <- struct{}{}:
	default:
	}
}

// Next returns the next event, waiting until one arrives, ctx ends, or the connection closes.
func (in *Inbox) Next(ctx context.Context) (Event, error) {
	for {
		in.mu.Lock()
		if len(in.queue) > 0 {
			event := in.queue[0]
			in.queue = in.queue[1:]
			in.mu.Unlock()
			return event, nil
		}
		closed := in.closed
		in.mu.Unlock()
		if closed {
			return Event{}, ErrClosed
		}
		select {
		case <-ctx.Done():
			return Event{}, ctx.Err()
		case <-in.signal:
		}
	}
}
```

- [ ] **Step 6: Run the tests**

Run: `GOTOOLCHAIN=local go test -race ./internal/browser/`
Expected: PASS.

- [ ] **Step 7: Tidy and commit**

```bash
GOTOOLCHAIN=local go mod tidy && git diff go.mod
git add go.mod go.sum internal/browser/cdp.go internal/browser/fake_test.go internal/browser/cdp_test.go
git commit -m "feat(snapshots): add a minimal CDP client

The client connects with a bearer token, matches replies to commands,
and queues each session's events without blocking its reader. It is
the base for rendering pages in obscura.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Page renderer

**Files:**
- Create: `internal/browser/render_test.go`, `internal/browser/render.go`

**Interfaces:**
- Consumes: Task 1's `Dial`, `Conn.Call`, `Conn.Events`, `Inbox.Next`, `CallError`, and the fake server helpers.
- Produces:
  - `browser.Browser{URL, Token string; Limits Limits}` and `(*Browser).Render(ctx context.Context, pageURL string) (*Page, error)`.
  - `Page{FinalURL string; HTTPStatus int; HTML, Screenshot []byte}`: `HTTPStatus` is 0 when the browser reported no document status.
  - `Limits{Navigation, Scripts, Quiet time.Duration; MaxRequests int; MaxBytes int64; Width, Height int}` and `DefaultLimits` (15 s, 10 s, 1 s, 300, 25 MB, 1280, 800).
  - `ErrUnavailable` (cannot connect or open a page; retryable), `ErrTimeout`, `*NavigationError{Text string}`.

- [ ] **Step 1: Write the failing renderer tests**

Create `internal/browser/render_test.go`. It holds the simulated page (`fakePage`) that answers the renderer's commands and the tests:

```go
package browser

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"sync"
	"testing"
	"time"
)

// fakeRequest is a sub-request the fake page makes after navigating.
type fakeRequest struct {
	ID   string
	Type string
	// Bytes, when set, is reported as transferred right after the request.
	Bytes int
}

// fakePage simulates one page behind the fake CDP server.
type fakePage struct {
	HTML          string
	FinalURL      string
	Status        int
	Requests      []fakeRequest
	NavigateError string
	NeverLoads    bool
	NoEmulation   bool

	mu       sync.Mutex
	resolved map[string]string
}

const fakeSession = "session-1"
const fakeFrame = "frame-1"

func (p *fakePage) handle(call fakeCall) fakeReply {
	switch call.Method {
	case "Target.createBrowserContext":
		return fakeReply{Result: map[string]any{"browserContextId": "context-1"}}
	case "Target.createTarget":
		return fakeReply{Result: map[string]any{"targetId": "target-1"}}
	case "Target.attachToTarget":
		return fakeReply{Result: map[string]any{"sessionId": fakeSession}}
	case "Page.getFrameTree":
		return fakeReply{Result: map[string]any{"frameTree": map[string]any{"frame": map[string]any{"id": fakeFrame}}}}
	case "Emulation.setDeviceMetricsOverride":
		if p.NoEmulation {
			return fakeReply{ErrCode: -32601, ErrMsg: "'Emulation.setDeviceMetricsOverride' wasn't found"}
		}
	case "Page.navigate":
		if p.NavigateError != "" {
			return fakeReply{Result: map[string]any{"frameId": fakeFrame, "errorText": p.NavigateError}}
		}
		events := []fakeEvent{
			{SessionID: fakeSession, Method: "Fetch.requestPaused", Params: map[string]any{"requestId": "document", "resourceType": "Document", "frameId": fakeFrame}},
			{SessionID: fakeSession, Method: "Network.responseReceived", Params: map[string]any{
				"type": "Document", "frameId": fakeFrame, "response": map[string]any{"url": p.FinalURL, "status": p.Status},
			}},
		}
		for _, request := range p.Requests {
			events = append(events, fakeEvent{SessionID: fakeSession, Method: "Fetch.requestPaused", Params: map[string]any{
				"requestId": request.ID, "resourceType": request.Type, "frameId": fakeFrame,
			}})
			if request.Bytes > 0 {
				events = append(events, fakeEvent{SessionID: fakeSession, Method: "Network.loadingFinished", Params: map[string]any{
					"requestId": request.ID, "encodedDataLength": request.Bytes,
				}})
			}
		}
		return fakeReply{Events: events, Result: map[string]any{"frameId": fakeFrame}}
	case "Fetch.continueRequest", "Fetch.failRequest":
		id, _ := call.param("requestId").(string)
		p.mu.Lock()
		if p.resolved == nil {
			p.resolved = map[string]string{}
		}
		p.resolved[id] = call.Method
		p.mu.Unlock()
	case "Runtime.evaluate":
		expression, _ := call.param("expression").(string)
		return fakeReply{Result: map[string]any{"result": map[string]any{"type": "string", "value": p.evaluate(expression)}}}
	case "Page.captureScreenshot":
		return fakeReply{Result: map[string]any{"data": base64.StdEncoding.EncodeToString(fakeScreenshot())}}
	}
	return fakeReply{}
}

func (p *fakePage) evaluate(expression string) string {
	switch expression {
	case "document.documentElement.outerHTML":
		return p.HTML
	case "location.href":
		return p.FinalURL
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.NeverLoads {
		return `["loading","about:blank"]`
	}
	state := "complete"
	if len(p.resolved) < len(p.Requests)+1 {
		state = "interactive"
	}
	pair, _ := json.Marshal([]string{state, p.FinalURL})
	return string(pair)
}

// resolution reports how a request was answered: Fetch.continueRequest, Fetch.failRequest, or "".
func (p *fakePage) resolution(id string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.resolved[id]
}

func fakeScreenshot() []byte {
	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 3)))
	return buf.Bytes()
}

var testLimits = Limits{
	Navigation:  time.Second,
	Scripts:     time.Second,
	Quiet:       10 * time.Millisecond,
	MaxRequests: 300,
	MaxBytes:    25 << 20,
	Width:       1280,
	Height:      800,
}

func renderFake(t *testing.T, page *fakePage, limits Limits) (*Page, *fakeCDP, error) {
	t.Helper()
	fake := newFakeCDP(t, "token", page.handle)
	browser := &Browser{URL: fake.URL(), Token: "token", Limits: limits}
	rendered, err := browser.Render(t.Context(), "https://site.test/start")
	return rendered, fake, err
}

func TestRenderReturnsTheRenderedPage(t *testing.T) {
	page := &fakePage{
		HTML:     "<html><body><p>rendered</p></body></html>",
		FinalURL: "https://site.test/final",
		Status:   200,
		Requests: []fakeRequest{{ID: "style", Type: "Stylesheet"}, {ID: "logo", Type: "Image"}},
	}

	rendered, fake, err := renderFake(t, page, testLimits)

	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if string(rendered.HTML) != page.HTML || rendered.FinalURL != page.FinalURL || rendered.HTTPStatus != 200 {
		t.Fatalf("page = %q %q %d, want the fake's HTML, final URL and status", rendered.HTML, rendered.FinalURL, rendered.HTTPStatus)
	}
	if !bytes.Equal(rendered.Screenshot, fakeScreenshot()) {
		t.Fatal("screenshot does not match the browser's capture")
	}
	navigations := fake.Calls("Page.navigate")
	if len(navigations) != 1 || navigations[0].param("url") != "https://site.test/start" || navigations[0].SessionID != fakeSession {
		t.Fatalf("navigations = %+v, want one to the requested URL in the page session", navigations)
	}
	created := fake.Calls("Target.createTarget")
	if len(created) != 1 || created[0].param("width") != float64(1280) || created[0].param("height") != float64(800) {
		t.Fatalf("createTarget = %+v, want a 1280x800 target", created)
	}
	if len(fake.Calls("Target.disposeBrowserContext")) != 1 {
		t.Fatal("the browser context was not disposed")
	}
}

func TestRenderFailsMediaAndFontsAndContinuesOtherRequests(t *testing.T) {
	page := &fakePage{
		HTML: "<html></html>", FinalURL: "https://site.test/", Status: 200,
		Requests: []fakeRequest{
			{ID: "video", Type: "Media"},
			{ID: "font", Type: "Font"},
			{ID: "script", Type: "Script"},
		},
	}

	if _, _, err := renderFake(t, page, testLimits); err != nil {
		t.Fatalf("Render: %v", err)
	}

	for id, want := range map[string]string{
		"document": "Fetch.continueRequest",
		"video":    "Fetch.failRequest",
		"font":     "Fetch.failRequest",
		"script":   "Fetch.continueRequest",
	} {
		if got := page.resolution(id); got != want {
			t.Errorf("%s answered with %q, want %q", id, got, want)
		}
	}
}

func TestRenderFailsRequestsBeyondTheLimits(t *testing.T) {
	limits := testLimits
	limits.MaxRequests = 2
	page := &fakePage{
		HTML: "<html></html>", FinalURL: "https://site.test/", Status: 200,
		Requests: []fakeRequest{{ID: "1", Type: "Image"}, {ID: "2", Type: "Image"}, {ID: "3", Type: "Image"}},
	}
	if _, _, err := renderFake(t, page, limits); err != nil {
		t.Fatalf("Render: %v", err)
	}
	if page.resolution("2") != "Fetch.continueRequest" || page.resolution("3") != "Fetch.failRequest" {
		t.Errorf("requests 2 and 3 = %q and %q, want the third one failed", page.resolution("2"), page.resolution("3"))
	}

	limits = testLimits
	limits.MaxBytes = 1000
	page = &fakePage{
		HTML: "<html></html>", FinalURL: "https://site.test/", Status: 200,
		Requests: []fakeRequest{{ID: "big", Type: "Image", Bytes: 5000}, {ID: "after", Type: "Image"}},
	}
	if _, _, err := renderFake(t, page, limits); err != nil {
		t.Fatalf("Render: %v", err)
	}
	if page.resolution("big") != "Fetch.continueRequest" || page.resolution("after") != "Fetch.failRequest" {
		t.Errorf("requests = %q and %q, want the one after the byte limit failed", page.resolution("big"), page.resolution("after"))
	}
}

func TestRenderWorksWithoutTheEmulationDomain(t *testing.T) {
	page := &fakePage{HTML: "<html></html>", FinalURL: "https://site.test/", Status: 200, NoEmulation: true}
	if _, _, err := renderFake(t, page, testLimits); err != nil {
		t.Fatalf("Render without Emulation: %v", err)
	}
}

func TestRenderReportsNavigationErrors(t *testing.T) {
	page := &fakePage{NavigateError: "net::ERR_NAME_NOT_RESOLVED"}
	_, _, err := renderFake(t, page, testLimits)
	var navigation *NavigationError
	if !errors.As(err, &navigation) || navigation.Text != "net::ERR_NAME_NOT_RESOLVED" {
		t.Fatalf("Render = %v, want a NavigationError", err)
	}
}

func TestRenderTimesOutWhenThePageNeverLoads(t *testing.T) {
	limits := testLimits
	limits.Navigation = 200 * time.Millisecond
	_, _, err := renderFake(t, &fakePage{NeverLoads: true}, limits)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("Render = %v, want ErrTimeout", err)
	}
}

func TestRenderReportsAnUnavailableBrowser(t *testing.T) {
	fake := newFakeCDP(t, "token", (&fakePage{}).handle)
	browser := &Browser{URL: fake.URL(), Token: "wrong", Limits: testLimits}
	if _, err := browser.Render(t.Context(), "https://site.test/"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Render with a wrong token = %v, want ErrUnavailable", err)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `GOTOOLCHAIN=local go test ./internal/browser/`
Expected: FAIL to compile with `undefined: Limits`, `undefined: Page`, `undefined: Browser`, and `undefined: ErrTimeout`.

- [ ] **Step 3: Implement the renderer**

Create `internal/browser/render.go`:

```go
package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrUnavailable reports a browser that could not take the page: unreachable,
// busy, or failing to open a context. Callers retry it.
var ErrUnavailable = errors.New("browser unavailable")

// ErrTimeout reports a page that did not load within the navigation limit.
var ErrTimeout = errors.New("browser timed out")

// NavigationError is a navigation the browser refused or could not complete.
type NavigationError struct {
	Text string
}

func (e *NavigationError) Error() string {
	return "navigation failed: " + e.Text
}

// Limits bound the work one render may do.
type Limits struct {
	// Navigation is how long the page has to become interactive.
	Navigation time.Duration
	// Scripts is how long scripts and late requests may run after that.
	Scripts time.Duration
	// Quiet is how long without new requests counts as settled.
	Quiet time.Duration
	// MaxRequests is how many sub-requests run before the rest are failed.
	MaxRequests int
	// MaxBytes is how many transferred bytes are allowed before the rest are failed.
	MaxBytes int64
	Width    int
	Height   int
}

// DefaultLimits are the snapshot rendering limits.
var DefaultLimits = Limits{
	Navigation:  15 * time.Second,
	Scripts:     10 * time.Second,
	Quiet:       time.Second,
	MaxRequests: 300,
	MaxBytes:    25 << 20,
	Width:       1280,
	Height:      800,
}

// blockedResourceTypes are never loaded.
var blockedResourceTypes = map[string]bool{"Media": true, "Font": true}

// Page is a rendered page.
type Page struct {
	FinalURL string
	// HTTPStatus is the main document's status, or 0 when the browser did not report it.
	HTTPStatus int
	HTML       []byte
	// Screenshot is the viewport as the browser encoded it (PNG or JPEG).
	Screenshot []byte
}

// Browser renders pages on a CDP endpoint, with one connection and one browser context per page.
type Browser struct {
	URL    string
	Token  string
	Limits Limits
}

// Render loads pageURL and returns its rendered HTML and a viewport screenshot.
func (b *Browser) Render(ctx context.Context, pageURL string) (*Page, error) {
	limits := b.Limits
	if limits == (Limits{}) {
		limits = DefaultLimits
	}
	conn, err := Dial(ctx, b.URL, b.Token)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer conn.Close()

	var created struct {
		BrowserContextID string `json:"browserContextId"`
	}
	if err := conn.Call(ctx, "", "Target.createBrowserContext", map[string]any{"disposeOnDetach": true}, &created); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = conn.Call(cleanup, "", "Target.disposeBrowserContext", map[string]any{"browserContextId": created.BrowserContextID}, nil)
	}()

	var target struct {
		TargetID string `json:"targetId"`
	}
	if err := conn.Call(ctx, "", "Target.createTarget", map[string]any{
		"url":              "about:blank",
		"browserContextId": created.BrowserContextID,
		"width":            limits.Width,
		"height":           limits.Height,
	}, &target); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := conn.Call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": target.TargetID, "flatten": true}, &attached); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	session := attached.SessionID
	events := conn.Events(session)
	call := func(ctx context.Context, method string, params, result any) error {
		return conn.Call(ctx, session, method, params, result)
	}

	for _, method := range []string{"Page.enable", "Network.enable"} {
		if err := call(ctx, method, nil, nil); err != nil {
			return nil, err
		}
	}
	// obscura does not document the Emulation domain; Target.createTarget already asked for the size.
	var callErr *CallError
	if err := call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width": limits.Width, "height": limits.Height, "deviceScaleFactor": 1, "mobile": false,
	}, nil); err != nil && !errors.As(err, &callErr) {
		return nil, err
	}
	var tree struct {
		FrameTree struct {
			Frame struct {
				ID string `json:"id"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if err := call(ctx, "Page.getFrameTree", nil, &tree); err != nil {
		return nil, err
	}
	if err := call(ctx, "Fetch.enable", map[string]any{"patterns": []map[string]any{{"urlPattern": "*"}}}, nil); err != nil {
		return nil, err
	}

	watch := &requestWatch{conn: conn, session: session, mainFrame: tree.FrameTree.Frame.ID, limits: limits}
	watchCtx, stopWatch := context.WithCancel(ctx)
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		watch.run(watchCtx, ctx, events)
	}()
	defer func() {
		stopWatch()
		<-watchDone
	}()

	navCtx, cancelNav := context.WithTimeout(ctx, limits.Navigation)
	defer cancelNav()
	var navigation struct {
		ErrorText string `json:"errorText"`
	}
	if err := call(navCtx, "Page.navigate", map[string]any{"url": pageURL}, &navigation); err != nil {
		return nil, timeoutError(err)
	}
	if navigation.ErrorText != "" {
		return nil, &NavigationError{Text: navigation.ErrorText}
	}
	if err := waitInteractive(navCtx, call); err != nil {
		return nil, err
	}
	scriptsCtx, cancelScripts := context.WithTimeout(ctx, limits.Scripts)
	waitSettled(scriptsCtx, call, watch, limits.Quiet)
	cancelScripts()

	html, err := evaluateString(ctx, call, "document.documentElement.outerHTML")
	if err != nil {
		return nil, timeoutError(err)
	}
	location, err := evaluateString(ctx, call, "location.href")
	if err != nil {
		return nil, timeoutError(err)
	}
	var shot struct {
		Data string `json:"data"`
	}
	if err := call(ctx, "Page.captureScreenshot", map[string]any{
		"format": "jpeg", "quality": 80, "captureBeyondViewport": false,
	}, &shot); err != nil {
		return nil, timeoutError(err)
	}
	screenshot, err := base64.StdEncoding.DecodeString(shot.Data)
	if err != nil {
		return nil, fmt.Errorf("decode screenshot: %w", err)
	}
	status, documentURL := watch.document()
	finalURL := location
	if documentURL != "" && (location == "" || location == "about:blank") {
		finalURL = documentURL
	}
	return &Page{FinalURL: finalURL, HTTPStatus: status, HTML: []byte(html), Screenshot: screenshot}, nil
}

type callFunc func(ctx context.Context, method string, params, result any) error

func timeoutError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: %v", ErrTimeout, err)
	}
	return err
}

func evaluateString(ctx context.Context, call callFunc, expression string) (string, error) {
	var evaluated struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	if err := call(ctx, "Runtime.evaluate", map[string]any{"expression": expression, "returnByValue": true}, &evaluated); err != nil {
		return "", err
	}
	if evaluated.ExceptionDetails != nil {
		return "", fmt.Errorf("evaluate %s: %s", expression, evaluated.ExceptionDetails.Text)
	}
	var value string
	if err := json.Unmarshal(evaluated.Result.Value, &value); err != nil {
		return "", fmt.Errorf("evaluate %s: not a string", expression)
	}
	return value, nil
}

// documentState reports the document's readyState and whether it is the navigated page, not about:blank.
func documentState(ctx context.Context, call callFunc) (state string, navigated bool, err error) {
	raw, err := evaluateString(ctx, call, `JSON.stringify([document.readyState, location.href])`)
	if err != nil {
		return "", false, err
	}
	var pair [2]string
	if err := json.Unmarshal([]byte(raw), &pair); err != nil {
		return "", false, fmt.Errorf("document state: %w", err)
	}
	return pair[0], pair[1] != "about:blank", nil
}

// waitInteractive polls until the navigated document has left the "loading" state.
func waitInteractive(ctx context.Context, call callFunc) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		state, navigated, err := documentState(ctx, call)
		if err == nil && navigated && state != "loading" {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: page did not load", ErrTimeout)
		case <-ticker.C:
		}
	}
}

// waitSettled waits until the document is complete and no request has started for quiet, or ctx ends.
func waitSettled(ctx context.Context, call callFunc, watch *requestWatch, quiet time.Duration) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		state, _, err := documentState(ctx, call)
		if err == nil && state == "complete" && watch.quietFor(quiet) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// requestWatch answers paused requests and records the main document's response.
type requestWatch struct {
	conn      *Conn
	session   string
	mainFrame string
	limits    Limits

	mu          sync.Mutex
	requests    int
	bytes       int64
	lastRequest time.Time
	status      int
	documentURL string
}

// run handles events until watchCtx ends; commands use callCtx so that stopping
// the watch never interrupts a command half-written.
func (w *requestWatch) run(watchCtx, callCtx context.Context, events *Inbox) {
	for {
		event, err := events.Next(watchCtx)
		if err != nil {
			return
		}
		switch event.Method {
		case "Fetch.requestPaused":
			w.handlePaused(callCtx, event.Params)
		case "Network.responseReceived":
			w.handleResponse(event.Params)
		case "Network.loadingFinished":
			w.handleFinished(event.Params)
		}
	}
}

func (w *requestWatch) handlePaused(ctx context.Context, raw json.RawMessage) {
	var paused struct {
		RequestID    string `json:"requestId"`
		ResourceType string `json:"resourceType"`
		FrameID      string `json:"frameId"`
	}
	if json.Unmarshal(raw, &paused) != nil || paused.RequestID == "" {
		return
	}
	mainDocument := paused.ResourceType == "Document" && paused.FrameID == w.mainFrame
	w.mu.Lock()
	w.lastRequest = time.Now()
	if !mainDocument {
		w.requests++
	}
	block := blockedResourceTypes[paused.ResourceType] ||
		(!mainDocument && (w.requests > w.limits.MaxRequests || w.bytes > w.limits.MaxBytes))
	w.mu.Unlock()
	if block {
		_ = w.conn.Call(ctx, w.session, "Fetch.failRequest", map[string]any{
			"requestId": paused.RequestID, "errorReason": "BlockedByClient",
		}, nil)
		return
	}
	_ = w.conn.Call(ctx, w.session, "Fetch.continueRequest", map[string]any{"requestId": paused.RequestID}, nil)
}

func (w *requestWatch) handleResponse(raw json.RawMessage) {
	var received struct {
		Type     string `json:"type"`
		FrameID  string `json:"frameId"`
		Response struct {
			URL    string `json:"url"`
			Status int    `json:"status"`
		} `json:"response"`
	}
	if json.Unmarshal(raw, &received) != nil || received.Type != "Document" || received.FrameID != w.mainFrame {
		return
	}
	w.mu.Lock()
	w.status = received.Response.Status
	w.documentURL = received.Response.URL
	w.mu.Unlock()
}

func (w *requestWatch) handleFinished(raw json.RawMessage) {
	var finished struct {
		EncodedDataLength float64 `json:"encodedDataLength"`
	}
	if json.Unmarshal(raw, &finished) != nil {
		return
	}
	w.mu.Lock()
	w.bytes += int64(finished.EncodedDataLength)
	w.mu.Unlock()
}

func (w *requestWatch) quietFor(quiet time.Duration) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return time.Since(w.lastRequest) >= quiet
}

func (w *requestWatch) document() (int, string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.status, w.documentURL
}
```

- [ ] **Step 4: Run the tests**

Run: `GOTOOLCHAIN=local go test -race ./internal/browser/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/browser/render.go internal/browser/render_test.go
git commit -m "feat(snapshots): render pages over CDP

Each page gets its own connection and browser context at 1280x800.
Media and font requests fail, requests past 300 or 25 MB fail, and the
page is read once its document is complete and quiet, within 15 s for
navigation and 10 s for scripts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Check the renderer against obscura

This is the spec's first verification: navigation, metadata, screenshots, request interception, download links, and video pages on a real obscura.

**Files:**
- Create: `internal/browser/obscura_integration_test.go`

**Interfaces:**
- Consumes: Task 2's `Browser`, `DefaultLimits`, `Page`.
- Produces: no code for later tasks. It produces findings: the obscura image digest and default command, and the behaviors marked `FINDING`. C2-2 needs them to pin the image and set its command in `docker-compose.yml`.

- [ ] **Step 1: Write the integration test**

Create `internal/browser/obscura_integration_test.go`:

```go
//go:build integration

// These tests check the renderer against a real obscura container (the C2-1
// plan's obscura check). They are not part of `go test ./...`.
//
// Start obscura (any CDP endpoint works the same way):
//
//	export OBSCURA_TEST_TOKEN=$(openssl rand -hex 32)
//	docker run -d --rm --name obscura-test -p 127.0.0.1:9333:9222 \
//	  -e OBSCURA_CDP_TOKEN="$OBSCURA_TEST_TOKEN" -e OBSCURA_ALLOW_PRIVATE_NETWORK=1 \
//	  --add-host=host.docker.internal:host-gateway h4ckf0r0day/obscura
//
// then run:
//
//	OBSCURA_TEST_URL=ws://127.0.0.1:9333/devtools/browser go test -tags integration -run Obscura -v ./internal/browser/
//
// The test site listens on all interfaces of this machine, and obscura
// reaches it at OBSCURA_TEST_SITE_HOST (default host.docker.internal), which
// is why the container allows private networks. Production containers never do.

package browser

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type obscuraSite struct {
	base  string
	mu    sync.Mutex
	paths []string
}

func (s *obscuraSite) requested(prefix string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, path := range s.paths {
		if strings.HasPrefix(path, prefix) {
			count++
		}
	}
	return count
}

const obscuraArticle = `<!doctype html><html><head><title>Obscura check</title>
<meta property="og:image" content="/cover.png">
<style>@font-face{font-family:Check;src:url(/font.woff2)} body{font-family:Check}</style>
</head><body><h1>Article</h1><p>Static text.</p>
<video src="/video.mp4" autoplay muted></video>
<img src="/img/1.png"><img src="/img/2.png"><img src="/img/3.png"><img src="/img/4.png"><img src="/img/5.png">
<script>document.addEventListener("DOMContentLoaded", function () {
  var p = document.createElement("p"); p.id = "from-script"; p.textContent = "rendered by script"; document.body.appendChild(p);
});</script>
</body></html>`

func startObscuraSite(t *testing.T) *obscuraSite {
	t.Helper()
	host := os.Getenv("OBSCURA_TEST_SITE_HOST")
	if host == "" {
		host = "host.docker.internal"
	}
	var pixel bytes.Buffer
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	png.Encode(&pixel, img)

	site := &obscuraSite{}
	mux := http.NewServeMux()
	mux.HandleFunc("/article", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(obscuraArticle))
	})
	mux.HandleFunc("/cover.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(pixel.Bytes())
	})
	mux.HandleFunc("/img/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(pixel.Bytes())
	})
	mux.HandleFunc("/font.woff2", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "font/woff2")
		w.Write([]byte("wOF2"))
	})
	mux.HandleFunc("/video.mp4", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Write(make([]byte, 1024))
	})
	mux.HandleFunc("/missing", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("<html><body><h1>Not found</h1></body></html>"))
	})
	mux.HandleFunc("/download.zip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="download.zip"`)
		w.Write(make([]byte, 64*1024))
	})
	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		site.mu.Lock()
		site.paths = append(site.paths, r.URL.Path)
		site.mu.Unlock()
		mux.ServeHTTP(w, r)
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	site.base = fmt.Sprintf("http://%s:%d", host, listener.Addr().(*net.TCPAddr).Port)
	return site
}

func obscura(t *testing.T, limits Limits) *Browser {
	t.Helper()
	url := os.Getenv("OBSCURA_TEST_URL")
	if url == "" {
		t.Skip("OBSCURA_TEST_URL is not set")
	}
	return &Browser{URL: url, Token: os.Getenv("OBSCURA_TEST_TOKEN"), Limits: limits}
}

func TestObscuraRendersScriptsAndScreenshots(t *testing.T) {
	browser := obscura(t, DefaultLimits)
	site := startObscuraSite(t)

	page, err := browser.Render(t.Context(), site.base+"/article")

	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	html := string(page.HTML)
	if !strings.Contains(html, "rendered by script") {
		t.Errorf("page scripts did not run; HTML:\n%s", html)
	}
	if !strings.Contains(html, `og:image`) {
		t.Errorf("rendered HTML lost the og:image meta tag")
	}
	if page.FinalURL != site.base+"/article" {
		t.Errorf("final URL = %q, want %q", page.FinalURL, site.base+"/article")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(page.Screenshot))
	if err != nil {
		t.Fatalf("screenshot does not decode: %v", err)
	}
	t.Logf("FINDING: screenshot is %s, %dx%d (1280x800 means the viewport size was applied)", format, config.Width, config.Height)
	t.Logf("FINDING: document status = %d (0 means Network.responseReceived was not reported)", page.HTTPStatus)
}

func TestObscuraHonorsRequestInterception(t *testing.T) {
	limits := DefaultLimits
	limits.MaxRequests = 3
	browser := obscura(t, limits)
	site := startObscuraSite(t)

	if _, err := browser.Render(t.Context(), site.base+"/article"); err != nil {
		t.Fatalf("Render: %v", err)
	}

	if got := site.requested("/font.woff2") + site.requested("/video.mp4"); got != 0 {
		t.Errorf("fonts and media reached the site %d times, want 0", got)
	}
	if got := site.requested("/img/"); got > 3 {
		t.Errorf("images reached the site %d times, want at most 3", got)
	}
	t.Logf("FINDING: site requests = %v", site.paths)
}

func TestObscuraReportsDocumentStatus(t *testing.T) {
	browser := obscura(t, DefaultLimits)
	site := startObscuraSite(t)

	page, err := browser.Render(t.Context(), site.base+"/missing")

	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	t.Logf("FINDING: a 404 page reports status %d (the capture falls back to the preflight status when it is 0)", page.HTTPStatus)
}

func TestObscuraFinishesOnDownloadLinks(t *testing.T) {
	browser := obscura(t, DefaultLimits)
	site := startObscuraSite(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	started := time.Now()

	page, err := browser.Render(ctx, site.base+"/download.zip")

	if elapsed := time.Since(started); elapsed > 26*time.Second {
		t.Fatalf("Render took %s on a download link, want it to give up within the limits", elapsed)
	}
	if err != nil {
		t.Logf("FINDING: a download link fails with %v", err)
		return
	}
	t.Logf("FINDING: a download link renders %d bytes of HTML with status %d", len(page.HTML), page.HTTPStatus)
}
```

- [ ] **Step 2: Check that it stays out of the normal test run**

Run: `GOTOOLCHAIN=local go vet -tags integration ./internal/browser/ && GOTOOLCHAIN=local go test ./internal/browser/`
Expected: vet reports nothing, and the normal run passes without the integration tests.

- [ ] **Step 3: Start obscura**

```bash
docker pull h4ckf0r0day/obscura:latest
docker image inspect h4ckf0r0day/obscura:latest --format '{{index .RepoDigests 0}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}'
export OBSCURA_TEST_TOKEN=$(openssl rand -hex 32)
docker run -d --rm --name obscura-test -p 127.0.0.1:9333:9222 \
  -e OBSCURA_CDP_TOKEN="$OBSCURA_TEST_TOKEN" -e OBSCURA_ALLOW_PRIVATE_NETWORK=1 \
  --add-host=host.docker.internal:host-gateway h4ckf0r0day/obscura:latest
sleep 3 && docker ps --filter name=obscura-test --format '{{.Status}}'
```

Expected: the inspect line prints a digest and the image's command, and `docker ps` shows the container as `Up`. If it is not running, run `docker logs obscura-test`. When the image's default command does not start `obscura serve`, rerun `docker run` with `serve --port 9222` appended after the image name, or `obscura serve --port 9222` when the inspect line shows an empty entrypoint.

- [ ] **Step 4: Run the check**

Run: `OBSCURA_TEST_URL=ws://127.0.0.1:9333/devtools/browser GOTOOLCHAIN=local go test -tags integration -run Obscura -count=1 -v ./internal/browser/`

Expected:
- PASS for `TestObscuraRendersScriptsAndScreenshots`, `TestObscuraHonorsRequestInterception`, `TestObscuraReportsDocumentStatus`, and `TestObscuraFinishesOnDownloadLinks`;
- `FINDING:` lines for the screenshot format and size, the document status, the site's requests, and the download link.

**Stop conditions.** Stop, do not start Task 4, and report the output together with `docker logs obscura-test` if:
- `Render` returns `browser unavailable`;
- page scripts did not run;
- the screenshot does not decode;
- fonts or media reached the test site;
- more than 3 images reached it;
- or a download link takes longer than the limits.

The fix may be in the client, for example a CDP method obscura names differently. The spec's fallback is a headless Chrome image, which speaks the same protocol, but the user chooses.

- [ ] **Step 5: Record the findings and stop obscura**

At the top of `internal/browser/obscura_integration_test.go`, directly below the `//go:build integration` line and its blank line, add a `// Verified against:` comment. Give one line for each of these:
- the image digest from Step 3, and the entrypoint and command;
- the screenshot format and size;
- the document status a 404 page reported;
- the site requests line;
- what the download link did.

Then run `docker stop obscura-test`.

- [ ] **Step 6: Commit**

```bash
git add internal/browser/obscura_integration_test.go
git commit -m "test(snapshots): check page rendering against obscura

The integration tests, run with -tags integration against an obscura
container, cover scripts, screenshots, request interception, the
document status, and download links. The header records the image and
behavior they were verified against.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Network guard and HTTP client

**Files:**
- Create: `internal/netguard/guard_test.go`, `internal/netguard/guard.go`

**Interfaces:**
- Produces:
  - `netguard.New(opts Options) *Guard`; `Options{AllowedPrefixes []netip.Prefix}` (tests allow `127.0.0.1/32`; production passes none).
  - `(*Guard).DialContext(ctx, network, address string) (net.Conn, error)` and `(*Guard).Client() *http.Client`.
  - `ValidateURL(raw string) (*url.URL, error)` and `IsBlocked(err error) bool`.
  - `ErrUnsupportedURL`, `ErrTooManyRedirects`, `UserAgent`, `MaxRedirects` (5).

- [ ] **Step 1: Add the SSRF library**

```bash
GOTOOLCHAIN=local go get code.dny.dev/ssrf@v0.3.0
git diff go.mod
```

Expected: one new `require` line; `go 1.25.0` unchanged.

- [ ] **Step 2: Write the failing tests**

Create `internal/netguard/guard_test.go`:

```go
package netguard

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
)

var loopback = Options{AllowedPrefixes: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}}

func TestDialRefusesAddressesThatAreNotPublic(t *testing.T) {
	guard := New(Options{})
	for _, address := range []string{
		"127.0.0.1:80",
		"10.1.2.3:443",
		"172.16.0.1:80",
		"192.168.1.1:8080",
		"169.254.169.254:80",
		"100.64.0.1:80",
		"0.0.0.0:80",
		"[::1]:80",
		"[fd00::1]:80",
		"[fe80::1]:80",
		"[::ffff:127.0.0.1]:80",
		"[64:ff9b::7f00:1]:80",
	} {
		conn, err := guard.DialContext(t.Context(), "tcp", address)
		if err == nil {
			conn.Close()
			t.Errorf("dial %s succeeded, want it refused", address)
			continue
		}
		if !IsBlocked(err) {
			t.Errorf("dial %s error = %v, want a refused address", address, err)
		}
	}
}

func TestValidateURL(t *testing.T) {
	for _, tc := range []struct {
		raw string
		ok  bool
	}{
		{"https://example.com/a?b=1", true},
		{"http://example.com:8080/", true},
		{"ftp://example.com/file", false},
		{"javascript:alert(1)", false},
		{"https:///no-host", false},
		{"https://user:secret@example.com/", false},
		{"/relative", false},
	} {
		_, err := ValidateURL(tc.raw)
		if tc.ok && err != nil {
			t.Errorf("ValidateURL(%q) = %v, want ok", tc.raw, err)
		}
		if !tc.ok && !errors.Is(err, ErrUnsupportedURL) {
			t.Errorf("ValidateURL(%q) = %v, want ErrUnsupportedURL", tc.raw, err)
		}
	}
}

func TestClientRefusesLocalServersByDefault(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer server.Close()

	_, err := New(Options{}).Client().Get(server.URL)

	if !IsBlocked(err) {
		t.Fatalf("Get = %v, want a refused address", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("the local server got %d requests, want none", hits.Load())
	}
}

func TestClientSendsItsUserAgentToAllowedServers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, r.UserAgent())
	}))
	defer server.Close()

	response, err := New(loopback).Client().Get(server.URL)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if string(body) != UserAgent {
		t.Fatalf("user agent = %q, want %q", body, UserAgent)
	}
}

func TestClientChecksEveryRedirect(t *testing.T) {
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()
	mux.HandleFunc("/hop/", func(w http.ResponseWriter, r *http.Request) {
		var left int
		fmt.Sscanf(strings.TrimPrefix(r.URL.Path, "/hop/"), "%d", &left)
		if left == 0 {
			io.WriteString(w, "arrived")
			return
		}
		http.Redirect(w, r, fmt.Sprintf("/hop/%d", left-1), http.StatusFound)
	})
	mux.HandleFunc("/to-private", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://10.0.0.1/admin", http.StatusFound)
	})
	mux.HandleFunc("/to-ftp", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "ftp://example.com/file", http.StatusFound)
	})
	mux.HandleFunc("/to-credentials", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://user:secret@example.com/", http.StatusFound)
	})
	client := New(loopback).Client()

	response, err := client.Get(server.URL + "/hop/5")
	if err != nil {
		t.Fatalf("five redirects: %v", err)
	}
	response.Body.Close()
	if _, err := client.Get(server.URL + "/hop/6"); !errors.Is(err, ErrTooManyRedirects) {
		t.Errorf("six redirects = %v, want ErrTooManyRedirects", err)
	}
	if _, err := client.Get(server.URL + "/to-private"); !IsBlocked(err) {
		t.Errorf("redirect to a private address = %v, want it refused", err)
	}
	for _, path := range []string{"/to-ftp", "/to-credentials"} {
		if _, err := client.Get(server.URL + path); !errors.Is(err, ErrUnsupportedURL) {
			t.Errorf("redirect %s = %v, want ErrUnsupportedURL", path, err)
		}
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `GOTOOLCHAIN=local go test ./internal/netguard/`
Expected: FAIL to compile with `undefined: Options`, `undefined: New`, `undefined: IsBlocked`, and `undefined: ValidateURL`.

- [ ] **Step 4: Implement the guard**

Create `internal/netguard/guard.go`:

```go
// Package netguard gives the snapshot worker network access that reaches
// only public addresses: an HTTP client for its own requests and a local
// proxy for programs that fetch on their own, such as monolith.
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"time"

	"code.dny.dev/ssrf"
)

// UserAgent identifies the snapshot worker's own requests.
const UserAgent = "Mozilla/5.0 (compatible; TabSlate-Snapshot/1.0; +https://github.com/TabSlate-dev/TabSlate-server)"

// MaxRedirects is how many redirects one request may follow.
const MaxRedirects = 5

// ErrUnsupportedURL reports a URL the worker never requests: not http(s), without a host, or with credentials.
var ErrUnsupportedURL = errors.New("unsupported URL")

// ErrTooManyRedirects reports a request that redirected more than MaxRedirects times.
var ErrTooManyRedirects = errors.New("too many redirects")

// Options adjust a Guard.
type Options struct {
	// AllowedPrefixes are reachable although they are not public. Tests use it for local servers.
	AllowedPrefixes []netip.Prefix
}

// Guard dials only public addresses. It checks the resolved address of every
// connection, so redirects and DNS rebinding cannot reach internal networks.
type Guard struct {
	dialer *net.Dialer
}

// New returns a Guard that allows any port on public addresses.
func New(opts Options) *Guard {
	options := []ssrf.Option{ssrf.WithAnyPort()}
	var v4, v6 []netip.Prefix
	for _, prefix := range opts.AllowedPrefixes {
		if prefix.Addr().Is4() {
			v4 = append(v4, prefix)
		} else {
			v6 = append(v6, prefix)
		}
	}
	if len(v4) > 0 {
		options = append(options, ssrf.WithAllowedV4Prefixes(v4...))
	}
	if len(v6) > 0 {
		options = append(options, ssrf.WithAllowedV6Prefixes(v6...))
	}
	return &Guard{dialer: &net.Dialer{Timeout: 10 * time.Second, Control: ssrf.New(options...).Safe}}
}

// DialContext connects like net.Dialer.DialContext and refuses addresses that are not public.
func (g *Guard) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return g.dialer.DialContext(ctx, network, address)
}

// IsBlocked reports whether err comes from refusing an address that is not public.
func IsBlocked(err error) bool {
	return errors.Is(err, ssrf.ErrProhibitedIP) ||
		errors.Is(err, ssrf.ErrProhibitedPort) ||
		errors.Is(err, ssrf.ErrProhibitedNetwork)
}

// ValidateURL accepts only absolute http and https URLs with a host and without credentials.
func ValidateURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnsupportedURL, err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return nil, ErrUnsupportedURL
	}
	return parsed, nil
}

// Client returns an HTTP client that dials through the guard, ignores proxy
// settings, follows at most MaxRedirects redirects to valid URLs, and sends UserAgent.
func (g *Guard) Client() *http.Client {
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            g.DialContext,
		ForceAttemptHTTP2:      true,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  15 * time.Second,
		MaxResponseHeaderBytes: 1 << 20,
		IdleConnTimeout:        30 * time.Second,
	}
	return &http.Client{
		Transport: userAgentTransport{base: transport},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > MaxRedirects {
				return ErrTooManyRedirects
			}
			_, err := ValidateURL(req.URL.String())
			return err
		},
	}
}

type userAgentTransport struct {
	base http.RoundTripper
}

func (t userAgentTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Header.Get("User-Agent") == "" {
		req = req.Clone(req.Context())
		req.Header.Set("User-Agent", UserAgent)
	}
	return t.base.RoundTrip(req)
}
```

- [ ] **Step 5: Run the tests**

Run: `GOTOOLCHAIN=local go test -race ./internal/netguard/`
Expected: PASS. The denied addresses include loopback, RFC 1918, link-local, CGNAT, `0.0.0.0`, IPv6 loopback and unique-local, IPv4-mapped IPv6, and NAT64 forms.

- [ ] **Step 6: Tidy and commit**

```bash
GOTOOLCHAIN=local go mod tidy && git diff go.mod
git add go.mod go.sum internal/netguard/guard.go internal/netguard/guard_test.go
git commit -m "feat(snapshots): reach only public addresses from the worker

The guard checks the resolved address of every connection, so neither
redirects nor DNS rebinding reach internal networks. Its HTTP client
follows at most 5 redirects to http(s) URLs without credentials,
ignores proxy settings, and identifies itself.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Egress proxy

**Files:**
- Create: `internal/netguard/proxy_test.go`, `internal/netguard/proxy.go`

**Interfaces:**
- Consumes: Task 4's `Guard`, `New`, `Options`, and the `loopback` test options in `guard_test.go`.
- Produces: `(*Guard).StartEgressProxy() (*EgressProxy, error)`, `EgressProxy{URL string}`, and `(*EgressProxy).Close() error`.

- [ ] **Step 1: Add goproxy**

```bash
GOTOOLCHAIN=local go get github.com/elazarl/goproxy@v1.9.2
git diff go.mod
```

Expected: new `require` lines only; `go 1.25.0` unchanged.

- [ ] **Step 2: Write the failing tests**

Create `internal/netguard/proxy_test.go`:

```go
package netguard

import (
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
)

func proxiedClient(t *testing.T, proxy *EgressProxy) *http.Client {
	t.Helper()
	proxyURL, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatalf("parse proxy URL: %v", err)
	}
	return &http.Client{Transport: &http.Transport{
		Proxy:           http.ProxyURL(proxyURL),
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
}

func TestEgressProxyForwardsToAllowedServers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "through the proxy")
	}))
	defer server.Close()
	proxy, err := New(loopback).StartEgressProxy()
	if err != nil {
		t.Fatalf("StartEgressProxy: %v", err)
	}
	defer proxy.Close()

	response, err := proxiedClient(t, proxy).Get(server.URL)
	if err != nil {
		t.Fatalf("Get through the proxy: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || string(body) != "through the proxy" {
		t.Fatalf("response = %d %q, want 200 from the server", response.StatusCode, body)
	}
}

func TestEgressProxyRefusesAddressesThatAreNotPublic(t *testing.T) {
	var hits atomic.Int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) })
	plain := httptest.NewServer(handler)
	defer plain.Close()
	secure := httptest.NewTLSServer(handler)
	defer secure.Close()
	proxy, err := New(Options{}).StartEgressProxy()
	if err != nil {
		t.Fatalf("StartEgressProxy: %v", err)
	}
	defer proxy.Close()
	client := proxiedClient(t, proxy)

	if response, err := client.Get(plain.URL); err == nil {
		response.Body.Close()
		if response.StatusCode == http.StatusOK {
			t.Errorf("plain HTTP through the proxy = 200, want a refusal")
		}
	}
	if response, err := client.Get(secure.URL); err == nil {
		response.Body.Close()
		t.Errorf("CONNECT through the proxy succeeded with %d, want it refused", response.StatusCode)
	}
	if hits.Load() != 0 {
		t.Fatalf("local servers got %d requests, want none", hits.Load())
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `GOTOOLCHAIN=local go test ./internal/netguard/`
Expected: FAIL to compile with `New(...).StartEgressProxy undefined (type *Guard has no field or method StartEgressProxy)` and `undefined: EgressProxy`.

- [ ] **Step 4: Implement the proxy**

Create `internal/netguard/proxy.go`:

```go
package netguard

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/elazarl/goproxy"
)

// EgressProxy is a local HTTP proxy whose outgoing connections, CONNECT
// tunnels included, go through a Guard.
type EgressProxy struct {
	// URL is the proxy's address, such as http://127.0.0.1:41234.
	URL    string
	server *http.Server
}

// StartEgressProxy starts a proxy on a random loopback port.
func (g *Guard) StartEgressProxy() (*EgressProxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("egress proxy: %w", err)
	}
	proxy := goproxy.NewProxyHttpServer()
	proxy.Logger = log.New(io.Discard, "", 0)
	proxy.Tr = &http.Transport{
		Proxy:                 nil,
		DialContext:           g.DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
	}
	proxy.ConnectDial = func(network, address string) (net.Conn, error) {
		return g.DialContext(context.Background(), network, address)
	}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return &EgressProxy{URL: "http://" + listener.Addr().String(), server: server}, nil
}

// Close stops the proxy and its open connections.
func (p *EgressProxy) Close() error {
	return p.server.Close()
}
```

- [ ] **Step 5: Run the tests**

Run: `GOTOOLCHAIN=local go test -race ./internal/netguard/`
Expected: PASS.

- [ ] **Step 6: Tidy and commit**

```bash
GOTOOLCHAIN=local go mod tidy && git diff go.mod
git add go.mod go.sum internal/netguard/proxy.go internal/netguard/proxy_test.go
git commit -m "feat(snapshots): add an egress proxy for archive downloads

monolith downloads page assets itself, so it gets a loopback proxy
whose plain and CONNECT connections go through the same guard as the
worker's own requests.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Reader version and cover URL

**Files:**
- Create: `internal/snapshots/capture/fixtures_test.go`, `internal/snapshots/capture/reader_test.go`, `internal/snapshots/capture/reader.go`

**Interfaces:**
- Produces:
  - `capture.ExtractReader(page []byte, pageURL *url.URL) *Reader`: nil when the page has no readable content, or when the sanitized result is over `maxReaderBytes` (2 MB).
  - `Reader{HTML []byte; Title, Excerpt string}`.
  - `CoverURL(page []byte, pageURL *url.URL) string`: the `og:image`, else `twitter:image`, resolved against `<base>` and the page; `""` when there is none or it is not http(s).
  - Test fixtures `paragraph` and `articleHTML(coverURL string) string`.
- Section 10's browser captures (C2-5) reuse `ExtractReader` and `CoverURL` on uploaded HTML.

- [ ] **Step 1: Add the readability and sanitizer libraries**

```bash
GOTOOLCHAIN=local go get codeberg.org/readeck/go-readability/v2@v2.1.3 github.com/microcosm-cc/bluemonday@v1.0.27
git diff go.mod
```

Expected: new `require` lines only. `go 1.25.0` and `golang.org/x/net v0.53.0` are unchanged.

- [ ] **Step 2: Write the fixtures and the failing tests**

Create `internal/snapshots/capture/fixtures_test.go`:

```go
package capture

import "strings"

var paragraph = strings.Repeat("The river town rebuilt its old stone bridge after the spring flood, and the people who crossed it every morning noticed how the new arches caught the light. ", 3)

// articleHTML is a rendered article page with a cover, a script, a style, a form and a frame.
func articleHTML(coverURL string) string {
	return `<!doctype html><html><head><title>Bridge story</title>` +
		`<meta property="og:image" content="` + coverURL + `">` +
		`<style>p{color:red}</style><script>steal()</script></head><body>` +
		`<nav><a href="/">Home</a></nav><article><h1>The bridge returns</h1>` +
		`<p onclick="steal()">` + paragraph + `</p><p style="color:blue">` + paragraph + `</p>` +
		`<img src="/img/arch.jpg" alt="Arch"><p>` + paragraph + ` <a href="https://example.org/more">more</a></p>` +
		`<form action="/x"><input name="q"></form><iframe src="https://ads.example.com/"></iframe>` +
		`</article></body></html>`
}
```

Create `internal/snapshots/capture/reader_test.go`:

```go
package capture

import (
	"net/url"
	"strings"
	"testing"
)

func TestExtractReaderKeepsTheArticleAndRemovesActiveContent(t *testing.T) {
	pageURL, _ := url.Parse("https://news.example.com/2026/10/story")

	reader := ExtractReader([]byte(articleHTML("/cover.png")), pageURL)

	if reader == nil {
		t.Fatal("ExtractReader = nil, want the article")
	}
	html := string(reader.HTML)
	if !strings.Contains(html, "The river town rebuilt its old stone bridge") {
		t.Errorf("reader lost the article text: %s", html)
	}
	for _, removed := range []string{"<script", "<style", "<form", "<iframe", "onclick", "style=", "steal()"} {
		if strings.Contains(html, removed) {
			t.Errorf("reader still contains %q", removed)
		}
	}
	if !strings.Contains(html, `src="https://news.example.com/img/arch.jpg"`) {
		t.Errorf("reader image does not keep its absolute original URL: %s", html)
	}
	if !strings.Contains(html, `target="_blank"`) || !strings.Contains(html, "noreferrer") {
		t.Errorf("reader links should open in a new tab without a referrer: %s", html)
	}
	if reader.Title != "Bridge story" || !strings.HasPrefix(reader.Excerpt, "The river town") {
		t.Errorf("title %q and excerpt %q, want the page title and the first paragraph", reader.Title, reader.Excerpt)
	}
}

func TestExtractReaderSkipsPagesWithoutReadableContent(t *testing.T) {
	pageURL, _ := url.Parse("https://app.example.com/")
	shell := `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`
	if reader := ExtractReader([]byte(shell), pageURL); reader != nil {
		t.Fatalf("ExtractReader = %q, want nil for an app shell", reader.HTML)
	}
}

func TestExtractReaderDropsReaderVersionsOverTheLimit(t *testing.T) {
	pageURL, _ := url.Parse("https://news.example.com/long")
	long := strings.Repeat(paragraph, 4)
	var body strings.Builder
	for range 1200 {
		body.WriteString("<p>" + long + "</p>")
	}
	page := "<html><head><title>Long</title></head><body><article>" + body.String() + "</article></body></html>"
	if reader := ExtractReader([]byte(page), pageURL); reader != nil {
		t.Fatalf("ExtractReader kept %d bytes, want nil over %d", len(reader.HTML), maxReaderBytes)
	}
}

func TestCoverURL(t *testing.T) {
	pageURL, _ := url.Parse("https://example.com/posts/1")
	for _, tc := range []struct {
		name string
		head string
		want string
	}{
		{"og:image", `<meta property="og:image" content="https://cdn.example.com/a.png">`, "https://cdn.example.com/a.png"},
		{"relative og:image", `<meta property="og:image" content="/img/a.png">`, "https://example.com/img/a.png"},
		{"twitter fallback", `<meta name="twitter:image" content="https://cdn.example.com/t.png">`, "https://cdn.example.com/t.png"},
		{"empty og:image", `<meta property="og:image" content=" "><meta property="twitter:image" content="/t.png">`, "https://example.com/t.png"},
		{"base element", `<base href="https://static.example.com/assets/"><meta property="og:image" content="a.png">`, "https://static.example.com/assets/a.png"},
		{"data URI", `<meta property="og:image" content="data:image/png;base64,AAAA">`, ""},
		{"none", `<title>Plain</title>`, ""},
	} {
		page := "<html><head>" + tc.head + "</head><body></body></html>"
		if got := CoverURL([]byte(page), pageURL); got != tc.want {
			t.Errorf("%s: CoverURL = %q, want %q", tc.name, got, tc.want)
		}
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `GOTOOLCHAIN=local go test ./internal/snapshots/capture/`
Expected: FAIL to compile with `undefined: ExtractReader`, `undefined: maxReaderBytes`, and `undefined: CoverURL`.

- [ ] **Step 4: Implement reader extraction and cover URLs**

Create `internal/snapshots/capture/reader.go`:

```go
package capture

import (
	"bytes"
	"net/url"
	"strings"

	"codeberg.org/readeck/go-readability/v2"
	"github.com/microcosm-cc/bluemonday"
	"golang.org/x/net/html"
)

// maxReaderBytes is the largest reader version kept; a longer one is dropped rather than cut.
const maxReaderBytes = 2 << 20

// Reader is a page's main content, sanitized.
type Reader struct {
	HTML    []byte
	Title   string
	Excerpt string
}

// readerPolicy removes scripts, event attributes, styles, forms and frames.
// A built policy is safe for concurrent use.
var readerPolicy = func() *bluemonday.Policy {
	policy := bluemonday.UGCPolicy()
	policy.AllowURLSchemes("http", "https", "mailto")
	policy.RequireParseableURLs(true)
	policy.RequireNoReferrerOnLinks(true)
	policy.AddTargetBlankToFullyQualifiedLinks(true)
	return policy
}()

// ExtractReader returns a page's readable content, or nil when the page has
// none (apps, home pages) or it is longer than maxReaderBytes. Images keep
// their original URLs, resolved against pageURL.
func ExtractReader(page []byte, pageURL *url.URL) *Reader {
	doc, err := html.Parse(bytes.NewReader(page))
	if err != nil || !readability.CheckDocument(doc) {
		return nil
	}
	article, err := readability.FromDocument(doc, pageURL)
	if err != nil || article.Node == nil {
		return nil
	}
	var rendered bytes.Buffer
	if err := article.RenderHTML(&rendered); err != nil {
		return nil
	}
	sanitized := readerPolicy.SanitizeBytes(rendered.Bytes())
	if len(sanitized) > maxReaderBytes {
		return nil
	}
	return &Reader{
		HTML:    sanitized,
		Title:   strings.TrimSpace(article.Title()),
		Excerpt: strings.TrimSpace(article.Excerpt()),
	}
}

// CoverURL returns a page's og:image, else its twitter:image, resolved against
// the page and its <base>; "" when it declares neither or the URL is not http(s).
func CoverURL(page []byte, pageURL *url.URL) string {
	doc, err := html.Parse(bytes.NewReader(page))
	if err != nil {
		return ""
	}
	base := pageURL
	var og, twitter string
	var visit func(node *html.Node)
	visit = func(node *html.Node) {
		if node.Type == html.ElementNode {
			switch node.Data {
			case "base":
				if href := attribute(node, "href"); href != "" && base == pageURL {
					if parsed, err := pageURL.Parse(href); err == nil {
						base = parsed
					}
				}
			case "meta":
				content := strings.TrimSpace(attribute(node, "content"))
				property, name := attribute(node, "property"), attribute(node, "name")
				if content != "" && property == "og:image" && og == "" {
					og = content
				}
				if content != "" && (property == "twitter:image" || name == "twitter:image") && twitter == "" {
					twitter = content
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(doc)
	raw := og
	if raw == "" {
		raw = twitter
	}
	if raw == "" {
		return ""
	}
	resolved, err := base.Parse(raw)
	if err != nil || (resolved.Scheme != "http" && resolved.Scheme != "https") {
		return ""
	}
	return resolved.String()
}

func attribute(node *html.Node, key string) string {
	for _, attr := range node.Attr {
		if attr.Key == key {
			return attr.Val
		}
	}
	return ""
}
```

- [ ] **Step 5: Run the tests**

Run: `GOTOOLCHAIN=local go test ./internal/snapshots/capture/`
Expected: PASS.

- [ ] **Step 6: Tidy and commit**

```bash
GOTOOLCHAIN=local go mod tidy && git diff go.mod
git add go.mod go.sum internal/snapshots/capture/reader.go internal/snapshots/capture/fixtures_test.go internal/snapshots/capture/reader_test.go
git commit -m "feat(snapshots): extract a page's reader version and cover URL

Readability finds the main content and bluemonday strips scripts,
event attributes, styles, forms and frames; images keep their original
URLs. Pages without readable content, or whose reader version passes
2 MB, get none. The cover URL is og:image, else twitter:image.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Cover copies and screenshots

**Files:**
- Create: `internal/snapshots/capture/images_test.go`, `internal/snapshots/capture/images.go`

**Interfaces:**
- Consumes: Task 4's `netguard.New`, `netguard.Options`, `(*Guard).Client()`, and `netguard.ValidateURL`.
- Produces:
  - `capture.FetchCover(ctx context.Context, client *http.Client, coverURL string) []byte`: a JPEG at most 640 px wide, or nil when there is no usable image.
  - `NormalizeScreenshot(data []byte) ([]byte, error)`: a JPEG of at most 1280×800.
  - Package helpers for Task 8: `errTooLarge`, `mediaTypeOf(contentType string) string`, and `readLimited(r io.Reader, limit int64) ([]byte, error)`.
  - Test helpers: `loopbackGuard()`, `pngImage(t, width, height, color)`, `decodeJPEG(t, data)`.

- [ ] **Step 1: Add the image library**

```bash
GOTOOLCHAIN=local go get golang.org/x/image@v0.38.0
git diff go.mod
```

Expected: a new `require` line for `golang.org/x/image v0.38.0` only. If `go get` reports `go: upgraded go 1.25.0 => 1.26.0`, undo with `git checkout go.mod go.sum` and stop: that version needs a newer Go.

- [ ] **Step 2: Write the failing tests**

Create `internal/snapshots/capture/images_test.go`:

```go
package capture

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/internal/netguard"
)

// loopbackGuard lets tests reach their local httptest servers.
func loopbackGuard() *netguard.Guard {
	return netguard.New(netguard.Options{AllowedPrefixes: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}})
}

func pngImage(t *testing.T, width, height int, fill color.Color) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			img.Set(x, y, fill)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func decodeJPEG(t *testing.T, data []byte) image.Image {
	t.Helper()
	decoded, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("not a JPEG: %v", err)
	}
	return decoded
}

// pngHeaderOnly is a PNG signature and IHDR chunk claiming the given size, with no pixel data.
func pngHeaderOnly(width, height uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], width)
	binary.BigEndian.PutUint32(ihdr[4:], height)
	ihdr[8], ihdr[9] = 8, 6 // 8-bit RGBA
	chunk := append([]byte("IHDR"), ihdr...)
	var out bytes.Buffer
	out.Write([]byte("\x89PNG\r\n\x1a\n"))
	binary.Write(&out, binary.BigEndian, uint32(len(ihdr)))
	out.Write(chunk)
	binary.Write(&out, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return out.Bytes()
}

func serveImage(t *testing.T, contentType string, body []byte) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server.URL + "/cover"
}

func TestFetchCoverScalesTheImageTo640PixelsWide(t *testing.T) {
	client := loopbackGuard().Client()
	url := serveImage(t, "image/png", pngImage(t, 1280, 640, color.NRGBA{R: 200, A: 255}))

	cover := FetchCover(t.Context(), client, url)

	if cover == nil {
		t.Fatal("cover = nil, want a JPEG")
	}
	if size := decodeJPEG(t, cover).Bounds().Size(); size != image.Pt(640, 320) {
		t.Fatalf("cover size = %v, want 640x320", size)
	}
}

func TestFetchCoverKeepsSmallImagesAndFlattensTransparency(t *testing.T) {
	client := loopbackGuard().Client()
	url := serveImage(t, "image/png", pngImage(t, 40, 20, color.NRGBA{}))

	cover := FetchCover(t.Context(), client, url)

	if cover == nil {
		t.Fatal("cover = nil, want a JPEG")
	}
	decoded := decodeJPEG(t, cover)
	if size := decoded.Bounds().Size(); size != image.Pt(40, 20) {
		t.Fatalf("cover size = %v, want the original 40x20", size)
	}
	if r, g, b, _ := decoded.At(5, 5).RGBA(); r < 0xf000 || g < 0xf000 || b < 0xf000 {
		t.Fatalf("transparent pixel = %d %d %d, want white", r>>8, g>>8, b>>8)
	}
}

func TestFetchCoverSkipsUnusableImages(t *testing.T) {
	client := loopbackGuard().Client()
	for name, url := range map[string]string{
		"not an image":       serveImage(t, "text/html", []byte("<html></html>")),
		"SVG":                serveImage(t, "image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)),
		"too many pixels":    serveImage(t, "image/png", pngHeaderOnly(20000, 20000)),
		"over the byte size": serveImage(t, "image/png", make([]byte, maxCoverBytes+1)),
		"not http":           "ftp://example.com/cover.png",
	} {
		if cover := FetchCover(t.Context(), client, url); cover != nil {
			t.Errorf("%s: FetchCover returned a cover, want nil", name)
		}
	}
}

func TestNormalizeScreenshotCropsToTheViewport(t *testing.T) {
	shot, err := NormalizeScreenshot(pngImage(t, 1440, 900, color.NRGBA{B: 200, A: 255}))
	if err != nil {
		t.Fatalf("NormalizeScreenshot: %v", err)
	}
	if size := decodeJPEG(t, shot).Bounds().Size(); size != image.Pt(1280, 800) {
		t.Fatalf("screenshot size = %v, want 1280x800", size)
	}
	if _, err := NormalizeScreenshot([]byte("not an image")); err == nil {
		t.Fatal("NormalizeScreenshot accepted bytes that are not an image")
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `GOTOOLCHAIN=local go test ./internal/snapshots/capture/`
Expected: FAIL to compile with `undefined: FetchCover`, `undefined: maxCoverBytes`, and `undefined: NormalizeScreenshot`.

- [ ] **Step 4: Implement the images**

Create `internal/snapshots/capture/images.go`:

```go
package capture

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net/http"
	"strings"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/TabSlate-dev/TabSlate-server/internal/netguard"
)

const (
	maxCoverBytes    = 5 << 20
	maxImagePixels   = 50_000_000
	coverWidth       = 640
	jpegQuality      = 80
	screenshotWidth  = 1280
	screenshotHeight = 800
)

var (
	errTooManyPixels = errors.New("image has too many pixels")
	errTooLarge      = errors.New("response too large")
)

// decodeChecked decodes an image after checking its dimensions, so oversized images are never decoded.
func decodeChecked(data []byte) (image.Image, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width*config.Height > maxImagePixels {
		return nil, errTooManyPixels
	}
	decoded, _, err := image.Decode(bytes.NewReader(data))
	return decoded, err
}

// encodeJPEG flattens transparency onto white, which JPEG cannot store.
func encodeJPEG(src image.Image, bounds image.Rectangle, width, height int) ([]byte, error) {
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
	if bounds.Dx() == width && bounds.Dy() == height {
		draw.Draw(dst, dst.Bounds(), src, bounds.Min, draw.Over)
	} else {
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, draw.Over, nil)
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// FetchCover downloads a cover image with client and returns a JPEG copy at most
// coverWidth pixels wide, or nil when there is no usable image: a failed
// request, not an image, over 5 MB, too many pixels, or a format the
// decoders cannot read (such as AVIF and SVG).
func FetchCover(ctx context.Context, client *http.Client, coverURL string) []byte {
	target, err := netguard.ValidateURL(coverURL)
	if err != nil {
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > maxCoverBytes ||
		!strings.HasPrefix(mediaTypeOf(response.Header.Get("Content-Type")), "image/") {
		return nil
	}
	data, err := readLimited(response.Body, maxCoverBytes)
	if err != nil {
		return nil
	}
	decoded, err := decodeChecked(data)
	if err != nil {
		return nil
	}
	bounds := decoded.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width > coverWidth {
		height = max(1, height*coverWidth/width)
		width = coverWidth
	}
	cover, err := encodeJPEG(decoded, bounds, width, height)
	if err != nil {
		return nil
	}
	return cover
}

// NormalizeScreenshot re-encodes a browser screenshot as a JPEG of at most
// the viewport, cropping from the top left when the browser captured more.
func NormalizeScreenshot(data []byte) ([]byte, error) {
	decoded, err := decodeChecked(data)
	if err != nil {
		return nil, err
	}
	bounds := decoded.Bounds()
	width, height := min(bounds.Dx(), screenshotWidth), min(bounds.Dy(), screenshotHeight)
	crop := image.Rect(bounds.Min.X, bounds.Min.Y, bounds.Min.X+width, bounds.Min.Y+height)
	return encodeJPEG(decoded, crop, width, height)
}

func mediaTypeOf(contentType string) string {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	return mediaType
}

// readLimited reads at most limit bytes, failing with errTooLarge when there are more.
func readLimited(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errTooLarge
	}
	return data, nil
}
```

- [ ] **Step 5: Run the tests**

Run: `GOTOOLCHAIN=local go test ./internal/snapshots/capture/`
Expected: PASS.

- [ ] **Step 6: Tidy and commit**

```bash
GOTOOLCHAIN=local go mod tidy && git diff go.mod
git add go.mod go.sum internal/snapshots/capture/images.go internal/snapshots/capture/images_test.go
git commit -m "feat(snapshots): copy covers and normalize screenshots

Covers of at most 5 MB are checked for their pixel count before
decoding, scaled to 640 px wide, and stored as JPEG on white;
formats the Go decoders cannot read get no cover. Screenshots become
JPEGs of at most the 1280x800 viewport.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Capturing a URL

**Files:**
- Create: `internal/snapshots/capture/capture_test.go`, `internal/snapshots/capture/failure.go`, `internal/snapshots/capture/preflight.go`, `internal/snapshots/capture/capture.go`

**Interfaces:**
- Consumes:
  - Task 2: `browser.Page`, `browser.ErrTimeout`, `browser.ErrUnavailable`, `*browser.NavigationError`.
  - Task 4: `netguard.Guard`, `netguard.ValidateURL`, `netguard.IsBlocked`, `netguard.ErrUnsupportedURL`, `netguard.ErrTooManyRedirects`.
  - Task 6: `ExtractReader`, `CoverURL`.
  - Task 7: `FetchCover`, `NormalizeScreenshot`, `readLimited`, `mediaTypeOf`, `errTooLarge`.
- Produces, used by C2-2's worker:
  - `capture.New(cfg Config) *Capturer` with `Config{Guard *netguard.Guard; Renderer Renderer; MonolithPath string; JobTimeout, ArchiveTimeout time.Duration; PerHost int}`. The defaults are 30 s, 60 s, and 2. `*browser.Browser` implements `Renderer`.
  - `(*Capturer).Capture(ctx context.Context, rawURL string) (*Result, error)`: every error is a `*Failure`.
  - `Result{Kind Kind; FinalURL string; HTTPStatus int; Title, Excerpt string; Reader, Screenshot, Cover, File *File}`, `File{Data []byte; ContentType string}`, and `Kind` values `KindPage`, `KindImage`, `KindPDF`.
  - `Failure{Reason Reason; HTTPStatus int; Retryable bool; Detail string; Err error}` and the `Reason` constants listed in the Global Constraints.
  - `ArchiveResult{FinalURL string; Archive File}`, used by Task 9.
  - Test helpers for Task 9: `testSite(t)`, `fakeRenderer`, `renderedArticle(t, site)`, `failureOf(t, err)`.

- [ ] **Step 1: Write the failing tests**

Create `internal/snapshots/capture/capture_test.go`:

```go
package capture

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/internal/browser"
	"github.com/TabSlate-dev/TabSlate-server/internal/netguard"
)

// testSite serves the pages the capture tests request.
func testSite(t *testing.T) *httptest.Server {
	t.Helper()
	cover := pngImage(t, 1280, 640, color.NRGBA{R: 200, A: 255})
	logo := pngImage(t, 20, 10, color.NRGBA{G: 200, A: 255})
	mux := http.NewServeMux()
	mux.HandleFunc("/article", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(articleHTML("/cover.png")))
	})
	mux.HandleFunc("/cover.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(cover)
	})
	mux.HandleFunc("/image.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(logo)
	})
	mux.HandleFunc("/doc.pdf", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		w.Write([]byte("%PDF-1.7 test"))
	})
	mux.HandleFunc("/no-type", func(w http.ResponseWriter, r *http.Request) {
		w.Header()["Content-Type"] = nil
		w.Write([]byte("<!doctype html><html><body><p>no declared type</p></body></html>"))
	})
	mux.HandleFunc("/video.mp4", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Write([]byte("not really a video"))
	})
	mux.HandleFunc("/download", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Disposition", `attachment; filename="page.html"`)
		w.Write([]byte("<html></html>"))
	})
	mux.HandleFunc("/huge", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Length", "6291456")
	})
	mux.HandleFunc("/huge-image", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", "22020096")
	})
	mux.HandleFunc("/missing", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusNotFound)
	})
	mux.HandleFunc("/busy", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "busy", http.StatusServiceUnavailable)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// fakeRenderer returns a fixed page, or an error, and tracks concurrency.
type fakeRenderer struct {
	page *browser.Page
	err  error
	// hold, when set, makes Render wait until it is closed.
	hold chan struct{}

	mu        sync.Mutex
	calls     []string
	active    int
	maxActive int
}

func (f *fakeRenderer) Render(ctx context.Context, pageURL string) (*browser.Page, error) {
	f.mu.Lock()
	f.calls = append(f.calls, pageURL)
	f.active++
	f.maxActive = max(f.maxActive, f.active)
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.active--
		f.mu.Unlock()
	}()
	if f.hold != nil {
		select {
		case <-f.hold:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	page := *f.page
	return &page, nil
}

func (f *fakeRenderer) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func renderedArticle(t *testing.T, site string) *browser.Page {
	return &browser.Page{
		FinalURL:   site + "/article",
		HTTPStatus: 200,
		HTML:       []byte(articleHTML("/cover.png")),
		Screenshot: pngImage(t, 1440, 900, color.NRGBA{B: 200, A: 255}),
	}
}

func failureOf(t *testing.T, err error) *Failure {
	t.Helper()
	var failure *Failure
	if !errors.As(err, &failure) {
		t.Fatalf("error = %v, want a *Failure", err)
	}
	return failure
}

func TestCapturePageKeepsReaderScreenshotAndCover(t *testing.T) {
	site := testSite(t)
	capturer := New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{page: renderedArticle(t, site.URL)}})

	result, err := capturer.Capture(t.Context(), site.URL+"/article")

	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if result.Kind != KindPage || result.FinalURL != site.URL+"/article" || result.HTTPStatus != 200 {
		t.Fatalf("result = %s %s %d, want a page at the final URL with status 200", result.Kind, result.FinalURL, result.HTTPStatus)
	}
	if result.Reader == nil || !strings.Contains(string(result.Reader.Data), "stone bridge") || result.Reader.ContentType != "text/html; charset=utf-8" {
		t.Fatalf("reader = %+v, want the sanitized article", result.Reader)
	}
	if result.Title != "Bridge story" || result.Excerpt == "" {
		t.Fatalf("title %q excerpt %q, want the reader's", result.Title, result.Excerpt)
	}
	if result.Screenshot == nil || decodeJPEG(t, result.Screenshot.Data).Bounds().Size() != image.Pt(1280, 800) {
		t.Fatal("screenshot missing or not a 1280x800 JPEG")
	}
	if result.Cover == nil || decodeJPEG(t, result.Cover.Data).Bounds().Size() != image.Pt(640, 320) {
		t.Fatal("cover missing or not scaled to 640x320")
	}
}

func TestCaptureKeepsImagesAndPDFsAsTheyAre(t *testing.T) {
	site := testSite(t)
	renderer := &fakeRenderer{}
	capturer := New(Config{Guard: loopbackGuard(), Renderer: renderer})

	image, err := capturer.Capture(t.Context(), site.URL+"/image.png")
	if err != nil || image.Kind != KindImage || image.File == nil || image.File.ContentType != "image/png" {
		t.Fatalf("image capture = %+v, %v; want the PNG itself", image, err)
	}
	pdf, err := capturer.Capture(t.Context(), site.URL+"/doc.pdf")
	if err != nil || pdf.Kind != KindPDF || string(pdf.File.Data) != "%PDF-1.7 test" {
		t.Fatalf("PDF capture = %+v, %v; want the PDF itself", pdf, err)
	}
	if renderer.callCount() != 0 {
		t.Fatalf("the browser rendered %d pages, want none for files", renderer.callCount())
	}
}

func TestCaptureSniffsAMissingContentType(t *testing.T) {
	site := testSite(t)
	renderer := &fakeRenderer{page: renderedArticle(t, site.URL)}
	capturer := New(Config{Guard: loopbackGuard(), Renderer: renderer})

	if _, err := capturer.Capture(t.Context(), site.URL+"/no-type"); err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if renderer.callCount() != 1 {
		t.Fatal("a page without a Content-Type was not rendered as HTML")
	}
}

func TestCaptureMarksUnsupportedAndOversizedLinks(t *testing.T) {
	site := testSite(t)
	renderer := &fakeRenderer{}
	capturer := New(Config{Guard: loopbackGuard(), Renderer: renderer})
	for _, tc := range []struct {
		url    string
		reason Reason
		detail string
	}{
		{site.URL + "/video.mp4", ReasonUnsupported, "video/mp4"},
		{site.URL + "/download", ReasonUnsupported, "attachment"},
		{"ftp://files.example.com/a.zip", ReasonUnsupported, "link type"},
		{site.URL + "/huge", ReasonTooLarge, "page"},
		{site.URL + "/huge-image", ReasonTooLarge, "image/png"},
	} {
		_, err := capturer.Capture(t.Context(), tc.url)
		failure := failureOf(t, err)
		if failure.Reason != tc.reason || failure.Detail != tc.detail || failure.Retryable {
			t.Errorf("%s: failure = %s %q retryable=%v, want %s %q", tc.url, failure.Reason, failure.Detail, failure.Retryable, tc.reason, tc.detail)
		}
	}
	if renderer.callCount() != 0 {
		t.Fatalf("the browser rendered %d pages, want none", renderer.callCount())
	}
}

func TestCaptureReportsHTTPErrors(t *testing.T) {
	site := testSite(t)
	capturer := New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{page: renderedArticle(t, site.URL)}})
	for path, want := range map[string]Failure{
		"/missing": {Reason: ReasonHTTPError, HTTPStatus: 404},
		"/busy":    {Reason: ReasonHTTPError, HTTPStatus: 503, Retryable: true},
	} {
		failure := failureOf(t, func() error { _, err := capturer.Capture(t.Context(), site.URL+path); return err }())
		if failure.Reason != want.Reason || failure.HTTPStatus != want.HTTPStatus || failure.Retryable != want.Retryable {
			t.Errorf("%s: failure = %+v, want %+v", path, failure, want)
		}
	}

	blockedPage := renderedArticle(t, site.URL)
	blockedPage.HTTPStatus = 403
	capturer = New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{page: blockedPage}})
	_, err := capturer.Capture(t.Context(), site.URL+"/article")
	if failure := failureOf(t, err); failure.Reason != ReasonHTTPError || failure.HTTPStatus != 403 {
		t.Fatalf("a page the browser got 403 for = %+v, want http_error 403", failure)
	}
}

func TestCaptureClassifiesNetworkFailures(t *testing.T) {
	site := testSite(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	closedURL := "http://" + listener.Addr().String() + "/"
	listener.Close()
	tlsSite := httptest.NewTLSServer(http.NotFoundHandler())
	defer tlsSite.Close()

	for _, tc := range []struct {
		name   string
		guard  *netguard.Guard
		url    string
		reason Reason
	}{
		{"private address", netguard.New(netguard.Options{}), site.URL + "/article", ReasonBlocked},
		{"refused connection", loopbackGuard(), closedURL, ReasonConnectError},
		{"unknown domain", loopbackGuard(), "http://does-not-exist.invalid/", ReasonDNSError},
		{"untrusted certificate", loopbackGuard(), tlsSite.URL + "/", ReasonTLSError},
	} {
		capturer := New(Config{Guard: tc.guard, Renderer: &fakeRenderer{}})
		_, err := capturer.Capture(t.Context(), tc.url)
		if failure := failureOf(t, err); failure.Reason != tc.reason || failure.Retryable {
			t.Errorf("%s: failure = %s retryable=%v, want %s", tc.name, failure.Reason, failure.Retryable, tc.reason)
		}
	}
}

func TestCaptureClassifiesBrowserFailures(t *testing.T) {
	site := testSite(t)
	for _, tc := range []struct {
		err       error
		reason    Reason
		retryable bool
	}{
		{fmt.Errorf("%w: slow", browser.ErrTimeout), ReasonTimeout, true},
		{fmt.Errorf("%w: busy", browser.ErrUnavailable), ReasonRenderError, true},
		{&browser.NavigationError{Text: "net::ERR_NAME_NOT_RESOLVED"}, ReasonDNSError, false},
		{&browser.NavigationError{Text: "net::ERR_CONNECTION_REFUSED"}, ReasonConnectError, false},
		{&browser.NavigationError{Text: "net::ERR_ABORTED"}, ReasonRenderError, false},
	} {
		capturer := New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{err: tc.err}})
		_, err := capturer.Capture(t.Context(), site.URL+"/article")
		if failure := failureOf(t, err); failure.Reason != tc.reason || failure.Retryable != tc.retryable {
			t.Errorf("%v: failure = %s retryable=%v, want %s retryable=%v", tc.err, failure.Reason, failure.Retryable, tc.reason, tc.retryable)
		}
	}
}

func TestCaptureFailsWhenThereIsNothingToKeep(t *testing.T) {
	site := testSite(t)
	page := renderedArticle(t, site.URL)
	page.HTML = []byte(`<html><body><div id="root"></div></body></html>`)
	page.Screenshot = []byte("not an image")
	capturer := New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{page: page}})

	_, err := capturer.Capture(t.Context(), site.URL+"/article")

	if failure := failureOf(t, err); failure.Reason != ReasonRenderError {
		t.Fatalf("failure = %s, want render_error", failure.Reason)
	}
}

func TestCaptureRunsAtMostTwoJobsPerSite(t *testing.T) {
	site := testSite(t)
	renderer := &fakeRenderer{page: renderedArticle(t, site.URL), hold: make(chan struct{})}
	capturer := New(Config{Guard: loopbackGuard(), Renderer: renderer})

	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			capturer.Capture(t.Context(), site.URL+"/article")
		}()
	}
	deadline := time.Now().Add(2 * time.Second)
	for renderer.callCount() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if calls := renderer.callCount(); calls != 2 {
		t.Errorf("renders started = %d, want 2 while the site's slots are taken", calls)
	}
	close(renderer.hold)
	wg.Wait()
	if renderer.maxActive != 2 || renderer.callCount() != 3 {
		t.Fatalf("max concurrent renders = %d of %d, want 2 of 3", renderer.maxActive, renderer.callCount())
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `GOTOOLCHAIN=local go test ./internal/snapshots/capture/`
Expected: FAIL to compile with `undefined: Failure`, `undefined: New`, `undefined: Config`, `undefined: KindPage`, and `undefined: ReasonUnsupported`.

- [ ] **Step 3: Implement failure classification**

Create `internal/snapshots/capture/failure.go`:

```go
package capture

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"strings"
	"syscall"

	"github.com/TabSlate-dev/TabSlate-server/internal/browser"
	"github.com/TabSlate-dev/TabSlate-server/internal/netguard"
)

// Reason is why a capture produced no snapshot. Snapshot rows store it.
type Reason string

const (
	ReasonTimeout      Reason = "timeout"
	ReasonBlocked      Reason = "blocked"
	ReasonDNSError     Reason = "dns_error"
	ReasonConnectError Reason = "connect_error"
	ReasonTLSError     Reason = "tls_error"
	ReasonHTTPError    Reason = "http_error"
	ReasonTooLarge     Reason = "too_large"
	ReasonUnsupported  Reason = "unsupported"
	ReasonRenderError  Reason = "render_error"
	ReasonFetchError   Reason = "fetch_error"
)

// Failure is a capture that produced no snapshot.
type Failure struct {
	Reason Reason
	// HTTPStatus is set for ReasonHTTPError.
	HTTPStatus int
	// Retryable failures go back to the queue: timeouts, 5xx and 429 responses, and a busy browser.
	Retryable bool
	// Detail explains the failure, such as the content type of an unsupported link.
	Detail string
	Err    error
}

func (f *Failure) Error() string {
	text := "capture failed: " + string(f.Reason)
	if f.HTTPStatus != 0 {
		text += fmt.Sprintf(" %d", f.HTTPStatus)
	}
	if f.Detail != "" {
		text += " (" + f.Detail + ")"
	}
	if f.Err != nil {
		text += ": " + f.Err.Error()
	}
	return text
}

func (f *Failure) Unwrap() error {
	return f.Err
}

func statusFailure(status int) *Failure {
	return &Failure{Reason: ReasonHTTPError, HTTPStatus: status, Retryable: status >= 500 || status == 429}
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// fetchFailure classifies an error from the worker's own HTTP requests.
func fetchFailure(err error) *Failure {
	var dnsErr *net.DNSError
	var certErr *tls.CertificateVerificationError
	var recordErr tls.RecordHeaderError
	switch {
	case netguard.IsBlocked(err):
		return &Failure{Reason: ReasonBlocked, Err: err}
	case errors.Is(err, netguard.ErrUnsupportedURL):
		return &Failure{Reason: ReasonUnsupported, Detail: "link type", Err: err}
	case errors.Is(err, netguard.ErrTooManyRedirects):
		return &Failure{Reason: ReasonFetchError, Detail: "too many redirects", Err: err}
	case errors.As(err, &dnsErr) && !dnsErr.IsTimeout:
		return &Failure{Reason: ReasonDNSError, Err: err}
	case isTimeout(err):
		return &Failure{Reason: ReasonTimeout, Retryable: true, Err: err}
	case errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.ECONNRESET),
		errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return &Failure{Reason: ReasonConnectError, Err: err}
	case errors.As(err, &certErr), errors.As(err, &recordErr):
		return &Failure{Reason: ReasonTLSError, Err: err}
	default:
		return &Failure{Reason: ReasonFetchError, Err: err}
	}
}

// renderFailure classifies an error from the browser.
func renderFailure(err error) *Failure {
	var navigation *browser.NavigationError
	switch {
	case errors.Is(err, browser.ErrTimeout), isTimeout(err):
		return &Failure{Reason: ReasonTimeout, Retryable: true, Err: err}
	case errors.Is(err, browser.ErrUnavailable):
		return &Failure{Reason: ReasonRenderError, Retryable: true, Detail: "browser busy", Err: err}
	case errors.As(err, &navigation):
		return navigationFailure(navigation)
	default:
		return &Failure{Reason: ReasonRenderError, Err: err}
	}
}

func navigationFailure(navigation *browser.NavigationError) *Failure {
	text := navigation.Text
	switch {
	case strings.Contains(text, "ERR_NAME_NOT_RESOLVED"):
		return &Failure{Reason: ReasonDNSError, Err: navigation}
	case strings.Contains(text, "ERR_CONNECTION_REFUSED"), strings.Contains(text, "ERR_CONNECTION_RESET"),
		strings.Contains(text, "ERR_ADDRESS_UNREACHABLE"):
		return &Failure{Reason: ReasonConnectError, Err: navigation}
	case strings.Contains(text, "ERR_TIMED_OUT"):
		return &Failure{Reason: ReasonTimeout, Retryable: true, Err: navigation}
	case strings.Contains(text, "ERR_CERT"), strings.Contains(text, "ERR_SSL"):
		return &Failure{Reason: ReasonTLSError, Err: navigation}
	default:
		return &Failure{Reason: ReasonRenderError, Detail: text, Err: navigation}
	}
}
```

- [ ] **Step 4: Implement the preflight**

Create `internal/snapshots/capture/preflight.go`:

```go
package capture

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
)

const (
	// maxPageBytes is the largest declared size of a page the browser renders.
	maxPageBytes = 5 << 20
	// maxFileBytes is the largest image or PDF stored as the snapshot itself.
	maxFileBytes = 20 << 20
)

type preflightResult struct {
	kind     Kind
	finalURL string
	status   int
	file     *File
}

// preflight requests the URL and decides from the response headers what to do:
// render HTML, keep an image or PDF as it is, or mark anything else unsupported.
// Only images and PDFs have their bodies read.
func (c *Capturer) preflight(ctx context.Context, target *url.URL) (*preflightResult, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, &Failure{Reason: ReasonUnsupported, Detail: "link type", Err: err}
	}
	response, err := c.client.Do(request)
	if err != nil {
		return nil, fetchFailure(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, statusFailure(response.StatusCode)
	}
	result := &preflightResult{finalURL: response.Request.URL.String(), status: response.StatusCode}
	if disposition, _, err := mime.ParseMediaType(response.Header.Get("Content-Disposition")); err == nil && disposition == "attachment" {
		return nil, &Failure{Reason: ReasonUnsupported, Detail: "attachment"}
	}
	body := io.Reader(response.Body)
	mediaType := mediaTypeOf(response.Header.Get("Content-Type"))
	if mediaType == "" {
		sniffed, err := io.ReadAll(io.LimitReader(response.Body, 512))
		if err != nil {
			return nil, fetchFailure(err)
		}
		mediaType = mediaTypeOf(http.DetectContentType(sniffed))
		body = io.MultiReader(bytes.NewReader(sniffed), response.Body)
	}
	switch {
	case mediaType == "text/html" || mediaType == "application/xhtml+xml":
		if response.ContentLength > maxPageBytes {
			return nil, &Failure{Reason: ReasonTooLarge, Detail: "page"}
		}
		result.kind = KindPage
		return result, nil
	case strings.HasPrefix(mediaType, "image/") || mediaType == "application/pdf":
		if response.ContentLength > maxFileBytes {
			return nil, &Failure{Reason: ReasonTooLarge, Detail: mediaType}
		}
		data, err := readLimited(body, maxFileBytes)
		if errors.Is(err, errTooLarge) {
			return nil, &Failure{Reason: ReasonTooLarge, Detail: mediaType}
		}
		if err != nil {
			return nil, fetchFailure(err)
		}
		result.kind = KindImage
		if mediaType == "application/pdf" {
			result.kind = KindPDF
		}
		result.file = &File{Data: data, ContentType: mediaType}
		return result, nil
	default:
		return nil, &Failure{Reason: ReasonUnsupported, Detail: mediaType}
	}
}
```

- [ ] **Step 5: Implement the capturer**

Create `internal/snapshots/capture/capture.go`:

```go
// Package capture turns a URL into snapshot files: a preflight request, a
// browser render, the reader version, a screenshot, a cover copy, and on
// demand a full-page archive. It knows nothing about storage, quotas, or queues.
package capture

import (
	"context"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/internal/browser"
	"github.com/TabSlate-dev/TabSlate-server/internal/netguard"
)

// Kind is what a snapshot holds.
type Kind string

const (
	KindPage  Kind = "page"
	KindImage Kind = "image"
	KindPDF   Kind = "pdf"
)

// File is one snapshot file.
type File struct {
	Data        []byte
	ContentType string
}

// Result is a successful capture.
type Result struct {
	Kind       Kind
	FinalURL   string
	HTTPStatus int
	// Title and Excerpt come from the reader version.
	Title   string
	Excerpt string
	// Reader, Screenshot and Cover belong to page snapshots; any may be nil.
	Reader     *File
	Screenshot *File
	Cover      *File
	// File is the image or PDF itself.
	File *File
}

// ArchiveResult is a full-page archive.
type ArchiveResult struct {
	FinalURL string
	Archive  File
}

// Renderer renders a page in a browser; *browser.Browser implements it.
type Renderer interface {
	Render(ctx context.Context, pageURL string) (*browser.Page, error)
}

// Config sets up a Capturer.
type Config struct {
	Guard    *netguard.Guard
	Renderer Renderer
	// MonolithPath is the monolith binary; empty turns full-page archives off.
	MonolithPath string
	// JobTimeout bounds one capture (default 30 s).
	JobTimeout time.Duration
	// ArchiveTimeout bounds one full-page archive (default 60 s).
	ArchiveTimeout time.Duration
	// PerHost is how many jobs may work on one site at a time (default 2).
	PerHost int
}

// Capturer runs captures. It is safe for concurrent use.
type Capturer struct {
	cfg    Config
	guard  *netguard.Guard
	client *http.Client
	hosts  *hostLimiter
}

// New returns a Capturer, filling in default limits.
func New(cfg Config) *Capturer {
	if cfg.JobTimeout == 0 {
		cfg.JobTimeout = 30 * time.Second
	}
	if cfg.ArchiveTimeout == 0 {
		cfg.ArchiveTimeout = 60 * time.Second
	}
	if cfg.PerHost == 0 {
		cfg.PerHost = 2
	}
	return &Capturer{
		cfg:    cfg,
		guard:  cfg.Guard,
		client: cfg.Guard.Client(),
		hosts:  &hostLimiter{limit: cfg.PerHost, slots: map[string]*hostSlot{}},
	}
}

// Capture takes a snapshot of rawURL. Errors are *Failure values.
func (c *Capturer) Capture(ctx context.Context, rawURL string) (*Result, error) {
	target, err := netguard.ValidateURL(rawURL)
	if err != nil {
		return nil, &Failure{Reason: ReasonUnsupported, Detail: "link type", Err: err}
	}
	release, err := c.hosts.acquire(ctx, target.Hostname())
	if err != nil {
		return nil, fetchFailure(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, c.cfg.JobTimeout)
	defer cancel()

	pre, err := c.preflight(ctx, target)
	if err != nil {
		return nil, err
	}
	if pre.kind != KindPage {
		return &Result{Kind: pre.kind, FinalURL: pre.finalURL, HTTPStatus: pre.status, File: pre.file}, nil
	}
	page, base, failure := c.render(ctx, target, pre)
	if failure != nil {
		return nil, failure
	}
	result := &Result{Kind: KindPage, FinalURL: base.String(), HTTPStatus: pageStatus(page.HTTPStatus, pre.status)}
	if reader := ExtractReader(page.HTML, base); reader != nil {
		result.Reader = &File{Data: reader.HTML, ContentType: "text/html; charset=utf-8"}
		result.Title, result.Excerpt = reader.Title, reader.Excerpt
	}
	if screenshot, err := NormalizeScreenshot(page.Screenshot); err == nil {
		result.Screenshot = &File{Data: screenshot, ContentType: "image/jpeg"}
	}
	if result.Reader == nil && result.Screenshot == nil {
		return nil, &Failure{Reason: ReasonRenderError, Detail: "nothing to keep"}
	}
	if coverURL := CoverURL(page.HTML, base); coverURL != "" {
		if cover := FetchCover(ctx, c.client, coverURL); cover != nil {
			result.Cover = &File{Data: cover, ContentType: "image/jpeg"}
		}
	}
	return result, nil
}

// render loads an HTML page in the browser and checks its status; the
// returned base is the page's final URL.
func (c *Capturer) render(ctx context.Context, target *url.URL, pre *preflightResult) (*browser.Page, *url.URL, *Failure) {
	page, err := c.cfg.Renderer.Render(ctx, target.String())
	if err != nil {
		return nil, nil, renderFailure(err)
	}
	if status := pageStatus(page.HTTPStatus, pre.status); status < 200 || status > 299 {
		return nil, nil, statusFailure(status)
	}
	base, err := netguard.ValidateURL(page.FinalURL)
	if err != nil {
		base, err = url.Parse(pre.finalURL)
		if err != nil {
			return nil, nil, &Failure{Reason: ReasonRenderError, Err: err}
		}
	}
	return page, base, nil
}

// pageStatus prefers the status the browser saw for the document, falling back to the preflight's.
func pageStatus(browserStatus, preflightStatus int) int {
	if browserStatus != 0 {
		return browserStatus
	}
	return preflightStatus
}

type hostSlot struct {
	tokens chan struct{}
	users  int
}

// hostLimiter caps concurrent jobs per host and forgets hosts nobody is using.
type hostLimiter struct {
	mu    sync.Mutex
	limit int
	slots map[string]*hostSlot
}

func (h *hostLimiter) acquire(ctx context.Context, host string) (func(), error) {
	h.mu.Lock()
	slot := h.slots[host]
	if slot == nil {
		slot = &hostSlot{tokens: make(chan struct{}, h.limit)}
		h.slots[host] = slot
	}
	slot.users++
	h.mu.Unlock()

	leave := func() {
		h.mu.Lock()
		slot.users--
		if slot.users == 0 {
			delete(h.slots, host)
		}
		h.mu.Unlock()
	}
	select {
	case slot.tokens <- struct{}{}:
		return func() {
			<-slot.tokens
			leave()
		}, nil
	case <-ctx.Done():
		leave()
		return nil, ctx.Err()
	}
}
```

- [ ] **Step 6: Run the tests**

Run: `GOTOOLCHAIN=local go test -race ./internal/snapshots/capture/`
Expected: PASS. The race run takes about 20 s because image scaling is slow under the race detector.

- [ ] **Step 7: Commit**

```bash
git add internal/snapshots/capture/capture.go internal/snapshots/capture/failure.go internal/snapshots/capture/preflight.go internal/snapshots/capture/capture_test.go
git commit -m "feat(snapshots): capture a URL into snapshot files

A header-only preflight renders HTML, keeps images and PDFs of at most
20 MB as they are, and marks attachments, media and other types
unsupported. Page captures keep the reader version, a screenshot and a
cover copy. Every failure carries a reason code and says whether the
queue should retry it, and each site gets at most two jobs at a time.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Full-page archives

**Files:**
- Create: `internal/snapshots/capture/archive_test.go`, `internal/snapshots/capture/archive.go`

**Interfaces:**
- Consumes:
  - Task 5: `(*Guard).StartEgressProxy()`.
  - Task 8: `Capturer` and its unexported `preflight` and `render`, `Failure`, `ArchiveResult`, `errTooLarge`, and the test helpers.
- Produces:
  - `(*Capturer).Archive(ctx context.Context, rawURL string) (*ArchiveResult, error)`: errors other than `ErrArchivesDisabled` are `*Failure` values.
  - `ErrArchivesDisabled`, returned when `Config.MonolithPath` is empty.

- [ ] **Step 1: Write the failing tests**

Create `internal/snapshots/capture/archive_test.go`. Its fake monolith is a shell script that prints its arguments and proxy variables, then echoes the page:

```go
package capture

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/internal/netguard"
)

// fakeMonolith writes a shell script that stands in for monolith.
func fakeMonolith(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "monolith")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatalf("write fake monolith: %v", err)
	}
	return path
}

func TestArchiveRunsMonolithThroughTheEgressProxy(t *testing.T) {
	site := testSite(t)
	monolith := fakeMonolith(t, `printf 'ARGS=%s\n' "$*"; printf 'PROXY=%s %s\n' "$https_proxy" "$HTTP_PROXY"; cat`)
	capturer := New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{page: renderedArticle(t, site.URL)}, MonolithPath: monolith})

	result, err := capturer.Archive(t.Context(), site.URL+"/article")

	if err != nil {
		t.Fatalf("Archive: %v", err)
	}
	output := string(result.Archive.Data)
	wantArgs := "ARGS=-I -j -e -a -v -q -b " + site.URL + "/article -u " + netguard.UserAgent + " -o - -"
	if !strings.Contains(output, wantArgs) {
		t.Errorf("monolith arguments:\n%s\nwant a line %q", output, wantArgs)
	}
	if !strings.Contains(output, "PROXY=http://127.0.0.1:") {
		t.Errorf("monolith did not get the egress proxy:\n%s", output)
	}
	if !strings.Contains(output, "stone bridge") || result.Archive.ContentType != "text/html; charset=utf-8" {
		t.Errorf("archive does not hold the rendered page")
	}
}

func TestArchiveDiscardsArchivesOver20MB(t *testing.T) {
	site := testSite(t)
	monolith := fakeMonolith(t, `head -c 21000000 /dev/zero`)
	capturer := New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{page: renderedArticle(t, site.URL)}, MonolithPath: monolith})

	_, err := capturer.Archive(t.Context(), site.URL+"/article")

	if failure := failureOf(t, err); failure.Reason != ReasonTooLarge || failure.Detail != "archive" {
		t.Fatalf("failure = %+v, want too_large for the archive", failure)
	}
}

func TestArchiveReportsMonolithErrors(t *testing.T) {
	site := testSite(t)
	monolith := fakeMonolith(t, `echo "cannot parse document" >&2; exit 3`)
	capturer := New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{page: renderedArticle(t, site.URL)}, MonolithPath: monolith})

	_, err := capturer.Archive(t.Context(), site.URL+"/article")

	failure := failureOf(t, err)
	if failure.Reason != ReasonRenderError || !strings.Contains(failure.Error(), "cannot parse document") {
		t.Fatalf("failure = %v, want render_error with monolith's message", failure)
	}
}

func TestArchiveNeedsMonolithAndAWebPage(t *testing.T) {
	site := testSite(t)
	if _, err := New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{}}).Archive(t.Context(), site.URL+"/article"); !errors.Is(err, ErrArchivesDisabled) {
		t.Errorf("Archive without monolith = %v, want ErrArchivesDisabled", err)
	}
	capturer := New(Config{Guard: loopbackGuard(), Renderer: &fakeRenderer{}, MonolithPath: fakeMonolith(t, "cat")})
	_, err := capturer.Archive(t.Context(), site.URL+"/image.png")
	if failure := failureOf(t, err); failure.Reason != ReasonUnsupported {
		t.Errorf("Archive of an image = %+v, want unsupported", failure)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `GOTOOLCHAIN=local go test ./internal/snapshots/capture/`
Expected: FAIL to compile with `capturer.Archive undefined (type *Capturer has no field or method Archive)` and `undefined: ErrArchivesDisabled`.

- [ ] **Step 3: Implement archives**

Create `internal/snapshots/capture/archive.go`:

```go
package capture

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"

	"github.com/TabSlate-dev/TabSlate-server/internal/netguard"
)

// maxArchiveBytes is the largest full-page archive kept.
const maxArchiveBytes = 20 << 20

// ErrArchivesDisabled reports a worker without monolith.
var ErrArchivesDisabled = errors.New("full-page archives are not configured")

// Archive renders a page again and saves it as one self-contained HTML file.
// Errors other than ErrArchivesDisabled are *Failure values.
func (c *Capturer) Archive(ctx context.Context, rawURL string) (*ArchiveResult, error) {
	if c.cfg.MonolithPath == "" {
		return nil, ErrArchivesDisabled
	}
	target, err := netguard.ValidateURL(rawURL)
	if err != nil {
		return nil, &Failure{Reason: ReasonUnsupported, Detail: "link type", Err: err}
	}
	release, err := c.hosts.acquire(ctx, target.Hostname())
	if err != nil {
		return nil, fetchFailure(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, c.cfg.ArchiveTimeout)
	defer cancel()

	pre, err := c.preflight(ctx, target)
	if err != nil {
		return nil, err
	}
	if pre.kind != KindPage {
		return nil, &Failure{Reason: ReasonUnsupported, Detail: "not a web page"}
	}
	page, base, failure := c.render(ctx, target, pre)
	if failure != nil {
		return nil, failure
	}
	archive, err := c.runMonolith(ctx, page.HTML, base.String())
	switch {
	case errors.Is(err, errTooLarge):
		return nil, &Failure{Reason: ReasonTooLarge, Detail: "archive"}
	case err != nil && ctx.Err() != nil:
		return nil, &Failure{Reason: ReasonTimeout, Retryable: true, Err: err}
	case err != nil:
		return nil, &Failure{Reason: ReasonRenderError, Detail: "archive", Err: err}
	}
	return &ArchiveResult{FinalURL: base.String(), Archive: File{Data: archive, ContentType: "text/html; charset=utf-8"}}, nil
}

// runMonolith inlines a rendered page's images, CSS and fonts, removes its
// JavaScript and isolates it from the network. monolith downloads assets
// itself, so it gets only the egress proxy, whose connections go through the guard.
func (c *Capturer) runMonolith(ctx context.Context, page []byte, baseURL string) ([]byte, error) {
	proxy, err := c.guard.StartEgressProxy()
	if err != nil {
		return nil, err
	}
	defer proxy.Close()

	command := exec.CommandContext(ctx, c.cfg.MonolithPath,
		"-I", "-j", "-e", "-a", "-v", "-q",
		"-b", baseURL, "-u", netguard.UserAgent, "-o", "-", "-")
	command.Stdin = bytes.NewReader(page)
	command.Env = []string{
		"http_proxy=" + proxy.URL, "https_proxy=" + proxy.URL,
		"HTTP_PROXY=" + proxy.URL, "HTTPS_PROXY=" + proxy.URL,
	}
	output := &limitedBuffer{limit: maxArchiveBytes}
	command.Stdout = output
	var stderr bytes.Buffer
	command.Stderr = &stderr
	err = command.Run()
	if output.exceeded {
		return nil, errTooLarge
	}
	if err != nil {
		message := stderr.String()
		if len(message) > 500 {
			message = message[:500]
		}
		return nil, fmt.Errorf("monolith: %w: %s", err, message)
	}
	return output.buf.Bytes(), nil
}

// limitedBuffer stops accepting output past its limit, which ends the writing process.
type limitedBuffer struct {
	buf      bytes.Buffer
	limit    int
	exceeded bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.buf.Len()+len(p) > b.limit {
		b.exceeded = true
		return 0, errTooLarge
	}
	return b.buf.Write(p)
}
```

- [ ] **Step 4: Run the tests**

Run: `GOTOOLCHAIN=local go test ./internal/snapshots/capture/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/snapshots/capture/archive.go internal/snapshots/capture/archive_test.go
git commit -m "feat(snapshots): save full-page archives with monolith

The page is rendered again and passed to monolith (-I -j -e -a -v),
which downloads assets only through the guarded egress proxy and sees
no other environment. Archives over 20 MB are discarded.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md` (the `### 包职责` table), `ARCHITECTURE.md` (the `## 目录结构` tree)

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Document the packages**

In `CLAUDE.md`, after the `internal/model` row of the `### 包职责` table, add:

```markdown
| `internal/netguard` | 内部 | 网页快照 Worker 的网络出口：只连接公网地址的拨号器（`code.dny.dev/ssrf`，每个连接在 DNS 解析后检查，重定向与 DNS rebinding 都到不了内网）、Worker 自身请求用的 HTTP 客户端（最多 5 次重定向，只接受不含凭据的 http(s) URL，忽略代理环境变量，固定 `UserAgent`），以及供 monolith 使用的本地出口代理（goproxy；普通请求与 CONNECT 都经同一拨号器） |
| `internal/browser` | 内部 | 自带的最小 CDP 客户端（`github.com/coder/websocket`，以 `Authorization: Bearer` 传 obscura 的 CDP token）与页面渲染：每个页面一条连接、一个 browser context，只用 obscura 文档列出的 CDP 方法；视口 1280×800，拒绝媒体与字体请求，超过 300 个子请求或 25 MB 后拒绝其余请求，导航 15 秒、脚本 10 秒；`-tags integration` 测试在真实 obscura 容器上验证 |
| `internal/snapshots/capture` | 内部 | 网页快照抓取核心，不读配置、不访问数据库、不入队：只读响应头的预检（HTML 交给浏览器；不超过 20 MB 的图片与 PDF 直接作为快照；视频、音频、附件等标记 unsupported）、阅读版（go-readability + bluemonday，最多 2 MB）、截图（JPEG q80，裁到视口）、封面副本（最多 5 MB，解码前检查像素数，640 px 宽 JPEG）、完整存档（monolith 经出口代理，最多 20 MB）、失败原因码与可重试判断；每个站点同时最多 2 个任务 |
```

In `ARCHITECTURE.md`, in the `## 目录结构` tree:
- after the `├── auth/` line, add `    ├── browser/             # 最小 CDP 客户端与页面渲染（obscura）；只用 obscura 文档列出的 CDP 方法`;
- after the `├── model/` line, add `    ├── netguard/            # 只连公网地址的拨号器、Worker 的 HTTP 客户端、供 monolith 用的出口代理`;
- after the `search/` entry and its child lines, add:

```text
    ├── snapshots/
    │   └── capture/         # 网页快照抓取核心：预检、渲染、阅读版、截图、封面副本、完整存档、失败原因码
```

- [ ] **Step 2: Run the full verification**

```bash
gofmt -l internal/
GOTOOLCHAIN=local go build ./...
GOTOOLCHAIN=local go vet ./...
GOTOOLCHAIN=local go vet -tags integration ./internal/browser/
GOTOOLCHAIN=local go test ./...
GOTOOLCHAIN=local go test -race ./internal/browser/ ./internal/netguard/ ./internal/snapshots/...
grep -n "^go \|^toolchain" go.mod
```

Expected:
- `gofmt` prints nothing, and build, vet, and both test runs pass.
- With `TEST_DATABASE_URL` unset, the handler tests skip as before.
- `go.mod` shows `go 1.25.0` and no `toolchain` line.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md
git commit -m "docs: describe the snapshot capture packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Report**

Report to the user:
- the branch (`feat/web-snapshots` in TabSlate-server, not pushed);
- the Task 3 findings: image digest, default command, screenshot size, document status, interception, and download links;
- anything the obscura check forced to change.

C2-2 uses these findings to pin obscura in `docker-compose.yml`.
