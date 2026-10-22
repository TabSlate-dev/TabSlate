import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertCircle, ChevronDown, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CollectionPicker } from "@/components/dashboard/shared/collection-picker";
import { DuplicateNotice } from "@/components/dashboard/shared/duplicate-notice";
import { TagPicker } from "@/components/dashboard/shared/tag-picker";
import { useTranslation } from "@/hooks/use-translation";
import type { BookmarkFormFocus } from "@/lib/bookmark-dialog-events";
import { bookmarkCreatedAtTime, MAX_BOOKMARK_NOTES_LENGTH } from "@/lib/bookmark-utils";
import { findVisibleDuplicates } from "@/lib/duplicate-lookup";
import { fetchPageMetadata, requestSiteAccess, type FetchPageMetadataError, type PageMetadata } from "@/lib/page-metadata";
import { revealBookmark } from "@/lib/reveal-bookmark";
import type { Bookmark, BookmarkBatchPatch } from "@/lib/types";
import { getActiveWorkspaceCollections, isActiveWorkspace, resolveActiveWorkspaceCollectionTarget } from "@/lib/workspace-visibility";
import { bookmarksAsArray, useBookmarksStore } from "@/store/bookmarks-store";
import { resolveAcceptLanguage } from "@/store/i18n-store";
import { useWorkspaceStore } from "@/store/workspace-store";

/** The notes field shows a counter above this length. */
const NOTES_COUNTER_FROM = 9_000;

const FETCH_ERROR_KEYS: Record<FetchPageMetadataError, string> = {
  timeout: "bookmarkForm_fetchTimeout",
  network: "bookmarkForm_fetchFailed",
  http: "bookmarkForm_fetchFailed",
  "not-html": "bookmarkForm_fetchNotHtml",
  "no-metadata": "bookmarkForm_fetchNoMetadata",
};

/** Failed thumbnails are not retried when the form reopens this page session. */
const failedFormCoverUrls = new Set<string>();

interface BookmarkFormProps {
  /** The bookmark to edit; omitted to add one. */
  bookmark?: Bookmark;
  /** The field that gets the cursor; the title by default. */
  focus?: BookmarkFormFocus;
  /** Called after a save, and when an edit changed nothing. */
  onDone: () => void;
  onCancel: () => void;
}

interface FieldErrors {
  title?: string;
  url?: string;
}

/** An address without "://" gets https://, and the result must parse. Null when it does not. */
export function normalizeBookmarkUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** The address "Fetch details" can request: the normalized URL, when it is http(s). */
function fetchableUrl(input: string): string | null {
  const candidate = normalizeBookmarkUrl(input);
  if (!candidate) {
    return null;
  }
  const { protocol } = new URL(candidate);
  return protocol === "http:" || protocol === "https:" ? candidate : null;
}

/** A text field changed when the user edited it and its saved value differs from the stored one. */
function changedText(input: string, saved: string, stored: string): string | undefined {
  return input !== stored && saved !== stored ? saved : undefined;
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tagId, index) => tagId === right[index]);
}

/**
 * The bookmark form body, without a container, so a dialog or a panel can
 * host it. Adding resolves the target collection again before saving; editing
 * writes only the fields the user changed, compared with the bookmark as the
 * form opened it, so fields changed on another device meanwhile survive.
 */
export function BookmarkForm({ bookmark, focus, onDone, onCancel }: BookmarkFormProps) {
  const { t, language } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const idPrefix = React.useId();
  const addBookmark = useBookmarksStore((s) => s.addBookmark);
  const updateBookmark = useBookmarksStore((s) => s.updateBookmark);
  const selectedCollection = useBookmarksStore((s) => s.selectedCollection);
  const storedBookmarks = useBookmarksStore((s) => s.bookmarks);
  const collections = useWorkspaceStore((s) => s.collections);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const activeCollections = React.useMemo(
    () => getActiveWorkspaceCollections(activeWorkspaceId, workspaces, collections),
    [activeWorkspaceId, workspaces, collections],
  );
  const defaultCollectionId = activeCollections.find((collection) => collection.isDefault)?.id ?? activeCollections[0]?.id ?? "";

  const [title, setTitle] = React.useState(bookmark?.title ?? "");
  const [url, setUrl] = React.useState(bookmark?.url ?? "");
  const [description, setDescription] = React.useState(bookmark?.description ?? "");
  const [notes, setNotes] = React.useState(bookmark?.notes ?? "");
  const [collectionId, setCollectionId] = React.useState(() => {
    if (bookmark) {
      return bookmark.collectionId;
    }
    const viewingCollection = pathname === "/" && activeCollections.some((collection) => collection.id === selectedCollection);
    return viewingCollection ? selectedCollection : defaultCollectionId;
  });
  const [tags, setTags] = React.useState<string[]>(() => [...(bookmark?.tags ?? [])]);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [targetUnavailable, setTargetUnavailable] = React.useState(false);
  const [changedElsewhere, setChangedElsewhere] = React.useState(false);
  const [duplicateUrl, setDuplicateUrl] = React.useState("");
  const notesRef = React.useRef<HTMLTextAreaElement>(null);
  const [coverUrl, setCoverUrl] = React.useState(bookmark?.imageUrl ?? "");
  // The address the cover belongs to; saving under another address clears the cover.
  const [coverUrlFor, setCoverUrlFor] = React.useState(bookmark?.url ?? "");
  const [fetched, setFetched] = React.useState<PageMetadata | null>(null);
  const [fetching, setFetching] = React.useState(false);
  const [fetchError, setFetchError] = React.useState("");
  // The address as typed, for a fetch that resolves after the user changed it.
  const urlRef = React.useRef(url);
  const fetchRevision = React.useRef(0);
  const [failedCoverUrl, setFailedCoverUrl] = React.useState("");

  React.useEffect(() => () => { fetchRevision.current += 1; }, []);

  React.useEffect(() => {
    if (focus !== "notes") {
      return;
    }
    const field = notesRef.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [focus]);

  React.useEffect(() => {
    const timer = setTimeout(() => setDuplicateUrl(url.trim()), 300);
    return () => clearTimeout(timer);
  }, [url]);

  const duplicateMatches = React.useMemo(() => {
    // Edit mode checks only once the address changes, and never matches the bookmark itself.
    if (!duplicateUrl || duplicateUrl === bookmark?.url) {
      return [];
    }
    const candidate = normalizeBookmarkUrl(duplicateUrl);
    if (!candidate) {
      return [];
    }
    return findVisibleDuplicates(
      candidate,
      { bookmarks: bookmarksAsArray(storedBookmarks), collections, workspaces },
      "loose",
    ).filter((match) => match.bookmark.id !== bookmark?.id);
  }, [duplicateUrl, bookmark, storedBookmarks, collections, workspaces]);

  const dateFormat = React.useMemo(
    () => new Intl.DateTimeFormat(resolveAcceptLanguage(language), { dateStyle: "medium" }),
    [language],
  );

  const selectedCollectionName = React.useMemo(() => {
    const collection = collections.find((candidate) => candidate.id === collectionId);
    if (!collection || collection.deletedAt || collection.archivedAt) {
      return undefined;
    }
    const workspace = workspaces.find((candidate) => candidate.id === collection.workspaceId);
    return isActiveWorkspace(workspace) ? collection.name : undefined;
  }, [collectionId, collections, workspaces]);
  const collectionLabel = collectionId === ""
    ? t("bookmarkForm_uncategorized")
    : selectedCollectionName ?? t("bookmarkForm_chooseCollection");

  const handleOpenExisting = (bookmarkId: string) => {
    onCancel();
    navigate("/");
    revealBookmark(bookmarkId);
  };

  const handleCollectionSelect = (id: string) => {
    setCollectionId(id);
    setTargetUnavailable(false);
  };

  // An untouched address is kept as it is, even if it predates the URL rule.
  const resolveSavedUrl = (input: string): string | null =>
    bookmark && input === bookmark.url ? bookmark.url : normalizeBookmarkUrl(input);
  /** The cover saved with an address: the form's cover when it belongs to that address, else none. */
  const coverForSave = (savedUrl: string): string => (savedUrl === coverUrlFor ? coverUrl : "");
  const shownCover = coverUrl && coverUrl !== failedCoverUrl && !failedFormCoverUrls.has(coverUrl)
    && resolveSavedUrl(url) === coverUrlFor ? coverUrl : "";
  const titleSuggestion = fetched && fetched.title && fetched.title !== title ? fetched.title : "";
  const descriptionSuggestion = fetched && fetched.description && fetched.description !== description ? fetched.description : "";

  const handleFetchDetails = async () => {
    const target = fetchableUrl(url);
    if (!target || fetching) {
      return;
    }
    const revision = ++fetchRevision.current;
    const isCurrent = () => revision === fetchRevision.current && fetchableUrl(urlRef.current) === target;
    setFetching(true);
    setFetchError("");
    try {
      // Request synchronously during the click, before the first await.
      const access = requestSiteAccess(target);
      const allowed = await access;
      if (!isCurrent()) {
        return;
      }
      if (!allowed) {
        setFetchError(t("bookmarkForm_fetchAccessDenied"));
        return;
      }
      const result = await fetchPageMetadata(target);
      if (!isCurrent()) {
        return;
      }
      if (result.status === "error") {
        setFetchError(t(FETCH_ERROR_KEYS[result.reason]));
        return;
      }
      const { metadata } = result;
      setFetched(metadata);
      // Empty fields take the fetched values; filled ones get a suggestion instead.
      setTitle((current) => (current.trim() ? current : metadata.title));
      setDescription((current) => (current.trim() ? current : metadata.description));
      if (metadata.title) {
        setErrors((current) => ({ ...current, title: undefined }));
      }
      setCoverUrl(metadata.imageUrl);
      setCoverUrlFor(target);
    } catch {
      if (isCurrent()) {
        setFetchError(t("bookmarkForm_fetchFailed"));
      }
    } finally {
      setFetching(false);
    }
  };

  // The dialog stays mounted while it animates closed, so a double-click or a
  // repeated Cmd/Ctrl+Enter must not save a second time.
  const finishedRef = React.useRef(false);
  const finish = () => {
    finishedRef.current = true;
    onDone();
  };

  const saveNew = (savedTitle: string, savedUrl: string) => {
    const state = useWorkspaceStore.getState();
    const target = resolveActiveWorkspaceCollectionTarget(
      collectionId || defaultCollectionId,
      state.activeWorkspaceId,
      state.workspaces,
      state.collections,
    );
    if (!target) {
      const refreshed = getActiveWorkspaceCollections(state.activeWorkspaceId, state.workspaces, state.collections);
      setCollectionId(refreshed.find((collection) => collection.isDefault)?.id ?? refreshed[0]?.id ?? "");
      setTargetUnavailable(true);
      return;
    }
    const added = addBookmark({
      title: savedTitle,
      url: savedUrl,
      description: description.trim(),
      notes: notes.trim(),
      imageUrl: coverForSave(savedUrl),
      favicon: "",
      collectionId: target.id,
      tags,
      seq: 0,
    });
    // An empty ID means the quota blocked the save; the quota alert says so, and the input stays.
    if (added.id) {
      finish();
    }
  };

  const saveEdit = (original: Bookmark, savedTitle: string, savedUrl: string) => {
    const current = useBookmarksStore.getState().bookmarks.get(original.id);
    const workspaceState = useWorkspaceStore.getState();
    const parent = workspaceState.collections.find((collection) => collection.id === current?.collectionId);
    const workspace = workspaceState.workspaces.find((candidate) => candidate.id === parent?.workspaceId);
    if (!current || (current.collectionId !== "" && (!parent || parent.deletedAt || parent.archivedAt || !isActiveWorkspace(workspace)))) {
      setChangedElsewhere(true);
      return;
    }
    const patch: BookmarkBatchPatch = {};
    const changedTitle = changedText(title, savedTitle, original.title);
    if (changedTitle !== undefined) { patch.title = changedTitle; }
    if (savedUrl !== original.url) { patch.url = savedUrl; }
    const effectiveUrl = patch.url ?? current.url;
    // An explicit address edit replaces its cover; fetched details must belong
    // to the live address, which may have changed elsewhere since opening.
    if (patch.url !== undefined || (fetched && effectiveUrl === coverUrlFor)) {
      patch.imageUrl = coverForSave(effectiveUrl);
    }
    const changedDescription = changedText(description, description.trim(), original.description);
    if (changedDescription !== undefined) { patch.description = changedDescription; }
    const changedNotes = changedText(notes, notes.trim(), original.notes ?? "");
    if (changedNotes !== undefined) { patch.notes = changedNotes; }
    if (collectionId !== original.collectionId) { patch.collectionId = collectionId; }
    if (!sameTags(tags, original.tags)) { patch.tags = tags; }

    if (Object.keys(patch).length === 0) {
      finish();
      return;
    }
    if (patch.collectionId !== undefined) {
      const state = useWorkspaceStore.getState();
      if (!resolveActiveWorkspaceCollectionTarget(patch.collectionId, state.activeWorkspaceId, state.workspaces, state.collections)) {
        setCollectionId(original.collectionId);
        setTargetUnavailable(true);
        return;
      }
    }
    updateBookmark(original.id, patch);
    finish();
  };

  const handleSave = () => {
    if (finishedRef.current) {
      return;
    }
    const savedTitle = title.trim();
    const savedUrl = resolveSavedUrl(url);
    setErrors({
      title: savedTitle ? undefined : t("bookmarkForm_errorTitle"),
      url: savedUrl ? undefined : t("bookmarkForm_errorUrl"),
    });
    if (!savedTitle || !savedUrl) {
      return;
    }
    if (bookmark) {
      saveEdit(bookmark, savedTitle, savedUrl);
    } else {
      saveNew(savedTitle, savedUrl);
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    // Portal descendants bubble through React even when another form owns the submit.
    if (event.target !== event.currentTarget) {
      return;
    }
    event.preventDefault();
    handleSave();
  };

  // Cmd/Ctrl+Enter saves from any field; plain Enter in the notes adds a line.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || !(event.target instanceof Element)) {
      return;
    }
    // A nested dialog's form handles its own keys; a portaled picker has no form and still saves.
    const ownerForm = event.target.closest("form");
    if (ownerForm !== null && ownerForm !== event.currentTarget) {
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSave();
    }
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit} onKeyDown={handleKeyDown} noValidate>
      {changedElsewhere && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{t("bookmarkForm_changedElsewhere")}</AlertDescription>
        </Alert>
      )}
      {targetUnavailable && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{t("workspaceVisibility_targetUnavailable")}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-title`}>{t("bookmarkForm_titleLabel")}</FieldLabel>
        <Input
          id={`${idPrefix}-title`}
          name="title"
          value={title}
          placeholder={t("bookmarkForm_titlePlaceholder")}
          autoFocus={focus === undefined}
          aria-invalid={errors.title !== undefined}
          aria-describedby={errors.title ? `${idPrefix}-title-error` : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
            setErrors((current) => ({ ...current, title: undefined }));
          }}
        />
        {errors.title && (
          <p id={`${idPrefix}-title-error`} role="alert" className="text-xs text-destructive">{errors.title}</p>
        )}
        {titleSuggestion && (
          <Button type="button" variant="link" size="sm" className="h-auto max-w-full justify-start p-0 text-xs" onClick={() => setTitle(titleSuggestion)}>
            <span className="truncate">{t("bookmarkForm_useFetched", [titleSuggestion])}</span>
          </Button>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-url`}>{t("bookmarkForm_urlLabel")}</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id={`${idPrefix}-url`}
            name="url"
            value={url}
            className="flex-1"
            placeholder={t("bookmarkForm_urlPlaceholder")}
            aria-invalid={errors.url !== undefined}
            aria-describedby={errors.url ? `${idPrefix}-url-error` : undefined}
            onChange={(event) => {
              fetchRevision.current += 1;
              setFetched(null);
              setFetchError("");
              setUrl(event.target.value);
              urlRef.current = event.target.value;
              setErrors((current) => ({ ...current, url: undefined }));
            }}
          />
          {shownCover && (
            <img
              src={shownCover}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => {
                failedFormCoverUrls.add(shownCover);
                setFailedCoverUrl(shownCover);
              }}
              data-form-cover=""
              referrerPolicy="no-referrer"
              className="aspect-[1.91/1] w-[4.3rem] shrink-0 rounded-md border object-cover"
            />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={fetching || fetchableUrl(url) === null}
            onClick={handleFetchDetails}
          >
            {fetching && <Loader2 className="size-4 animate-spin" />}
            {t(fetching ? "bookmarkForm_fetchingDetails" : "bookmarkForm_fetchDetails")}
          </Button>
        </div>
        {errors.url && (
          <p id={`${idPrefix}-url-error`} role="alert" className="text-xs text-destructive">{errors.url}</p>
        )}
        {fetchError && <p role="alert" className="text-xs text-destructive">{fetchError}</p>}
      </Field>
      <DuplicateNotice matches={duplicateMatches} onOpenExisting={handleOpenExisting} />
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-description`}>{t("bookmarkForm_descriptionLabel")}</FieldLabel>
        <Input
          id={`${idPrefix}-description`}
          name="description"
          value={description}
          placeholder={t("bookmarkForm_descriptionPlaceholder")}
          onChange={(event) => setDescription(event.target.value)}
        />
        {descriptionSuggestion && (
          <Button type="button" variant="link" size="sm" className="h-auto max-w-full justify-start p-0 text-xs" onClick={() => setDescription(descriptionSuggestion)}>
            <span className="truncate">{t("bookmarkForm_useFetched", [descriptionSuggestion])}</span>
          </Button>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-notes`}>{t("bookmarkForm_notesLabel")}</FieldLabel>
        <Textarea
          ref={notesRef}
          id={`${idPrefix}-notes`}
          name="notes"
          value={notes}
          maxLength={MAX_BOOKMARK_NOTES_LENGTH}
          placeholder={t("bookmarkForm_notesPlaceholder")}
          className="max-h-60"
          onChange={(event) => setNotes(event.target.value)}
        />
        {notes.length > NOTES_COUNTER_FROM && (
          <p className="text-right text-xs text-muted-foreground">
            {t("bookmarkForm_notesCounter", [String(notes.length), String(MAX_BOOKMARK_NOTES_LENGTH)])}
          </p>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-collection`}>{t("bookmarkForm_collectionLabel")}</FieldLabel>
        <CollectionPicker selectedId={collectionId} onSelect={handleCollectionSelect}>
          <Button id={`${idPrefix}-collection`} type="button" variant="outline" className="w-full justify-between font-normal">
            <span className="truncate">{collectionLabel}</span>
            <ChevronDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </CollectionPicker>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-tags`}>{t("bookmarkForm_tagsLabel")}</FieldLabel>
        <TagPicker value={tags} onChange={setTags} inputId={`${idPrefix}-tags`} autoFocus={focus === "tags"} />
      </Field>
      {bookmark && (
        <p className="text-xs text-muted-foreground">
          {t("bookmarkForm_added", [dateFormat.format(bookmarkCreatedAtTime(bookmark.createdAt))])}
          {bookmark.updatedAt !== undefined && ` · ${t("bookmarkForm_updated", [dateFormat.format(bookmark.updatedAt)])}`}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("settings_cancel")}
        </Button>
        <Button type="submit" size="sm">
          {t(bookmark ? "bookmarkForm_save" : "bookmarkForm_add")}
        </Button>
      </div>
    </form>
  );
}
