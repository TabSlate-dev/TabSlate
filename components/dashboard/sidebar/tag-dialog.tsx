import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TAG_COLORS } from "@/store/workspace-store";
import { useTranslation } from "@/hooks/use-translation";
import { tagTargetError, type TagActionResult } from "@/lib/tag-mutations";
import { displayTagPath, tagAncestors } from "@/lib/tag-tree";
import type { Tag } from "@/lib/types";
import { tagNameError } from "@/lib/tag-name";
import { useTagTree } from "@/hooks/use-tag-tree";
import { TagTreePicker } from "@/components/dashboard/shared/tag-tree-picker";

interface TagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tag being edited; omitted when creating one. */
  initial?: Tag;
  /** Pre-selected parent tag ID for creating a child tag. */
  initialParentId?: string;
  /** Names of the other tags, used to reject duplicates. */
  takenNames?: readonly string[];
  onSubmit: (input: { name: string; color: string; parentId?: string }) => Promise<TagActionResult>;
}

export function TagDialog({
  open,
  onOpenChange,
  initial,
  initialParentId,
  takenNames,
  onSubmit,
}: TagDialogProps) {
  const { t } = useTranslation();
  const tree = useTagTree();
  const [name, setName] = React.useState(initial?.name ?? "");
  const [color, setColor] = React.useState<string>(initial?.color ?? TAG_COLORS[0]);
  const [parentId, setParentId] = React.useState<string | undefined>(initial?.parentId ?? initialParentId);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const requestGeneration = React.useRef(0);
  const pendingRequest = React.useRef<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useLayoutEffect(() => {
    requestGeneration.current += 1;
    pendingRequest.current = null;
    setPending(false);
    if (open) {
      setName(initial?.name ?? "");
      setColor(initial?.color ?? TAG_COLORS[0]);
      setParentId(initial?.parentId ?? initialParentId);
      setPickerOpen(false);
      setError(null);
    }
    return () => {
      requestGeneration.current += 1;
    };
  }, [open, initial, initialParentId]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      requestGeneration.current += 1;
      pendingRequest.current = null;
      setPending(false);
    }
    onOpenChange(nextOpen);
  };

  const disabledReasonForParent = React.useCallback(
    (candidateId: string | undefined): string | undefined => {
      if (initial) {
        if (candidateId === initial.id) {
          return "tagAction_targetSelf";
        }
        const err = tagTargetError(tree, initial.id, candidateId, "move");
        if (err === "cycle") {
          return "tagAction_targetDescendant";
        }
        if (err === "depth") {
          return "tagAction_targetDepth";
        }
        if (err === "duplicate") {
          return "tagAction_targetDuplicate";
        }
        return undefined;
      }
      if (candidateId !== undefined) {
        const depth = tagAncestors(tree, candidateId).length + 1;
        if (depth >= 5) {
          return "tagAction_targetDepth";
        }
      }
      return undefined;
    },
    [initial, tree],
  );

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRequest.current !== null) {
      return;
    }

    const nameChanged = initial ? name !== initial.name : true;
    if (nameChanged) {
      if (!initial && name.includes("/")) {
        const segments = name.split("/").map((segment) => segment.trim());
        if (segments.some((segment) => !segment)) {
          setError(t("tagDialog_errorEmpty"));
          return;
        }
        if (segments.some((segment) => tagNameError(segment, []) !== null)) {
          setError(t("tagAction_errorInvalid"));
          return;
        }
        const parentDepth = parentId !== undefined ? tagAncestors(tree, parentId).length + 1 : 0;
        if (parentDepth + segments.length > 5) {
          setError(t("tagAction_targetDepth"));
          return;
        }
      } else {
        const siblingIds = tree.childrenByParent.get(parentId) ?? [];
        const siblingNames = siblingIds
          .filter((id) => !initial || id !== initial.id)
          .map((id) => tree.tagsById.get(id)?.name ?? "");
        const problem = tagNameError(name, takenNames ?? siblingNames);
        if (problem) {
          setError(
            t(
              problem === "empty"
                ? "tagDialog_errorEmpty"
                : problem === "duplicate"
                  ? "tagDialog_errorDuplicate"
                  : "tagAction_errorInvalid",
            ),
          );
          return;
        }
      }
    }

    const parentReason = disabledReasonForParent(parentId);
    if (parentReason) {
      setError(t(parentReason));
      return;
    }

    const generation = ++requestGeneration.current;
    pendingRequest.current = generation;
    setPending(true);
    try {
      const finalName = initial && !nameChanged ? initial.name : name.trim();
      const result = await onSubmit({ name: finalName, color, parentId });
      if (generation !== requestGeneration.current) {
        return;
      }
      if (!result.ok) {
        setError(
          t(
            result.error === "storage"
              ? "tagAction_errorStorage"
              : result.error === "stale"
                ? "tagAction_errorStale"
                : result.error === "quota"
                  ? "tagAction_errorQuota"
                  : result.error === "depth"
                    ? "tagAction_targetDepth"
                    : result.error === "duplicate"
                      ? "tagDialog_errorDuplicate"
                      : "tagAction_errorInvalid",
          ),
        );
        return;
      }
      onOpenChange(false);
    } finally {
      if (generation === requestGeneration.current) {
        pendingRequest.current = null;
        setPending(false);
      }
    }
  };

  const parentName =
    parentId === undefined
      ? t("tagDialog_parentNone")
      : (displayTagPath(tree, parentId) || tree.tagsById.get(parentId)?.name || t("tagDialog_parentNone"));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>{t(initial ? "tagDialog_editTitle" : "tagDialog_newTitle")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t(initial ? "tagDialog_editDesc" : "tagDialog_newDesc")}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4 pt-1" onSubmit={handleSubmit} noValidate>
          <Field>
            <FieldLabel htmlFor="tag-name">{t("tagDialog_nameLabel")}</FieldLabel>
            <Input
              id="tag-name"
              name="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder={t("tagDialog_namePlaceholder")}
              aria-invalid={error !== null}
              aria-describedby={error ? "tag-name-error" : undefined}
              autoFocus
            />
            {error && (
              <p id="tag-name-error" role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </Field>

          <Field>
            <FieldLabel>{t("tagDialog_parentLabel")}</FieldLabel>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs rounded border px-2 py-1.5">
                <span className="truncate text-muted-foreground">{parentName}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs ml-2"
                  onClick={() => setPickerOpen((prev) => !prev)}
                >
                  {t("tagDialog_changeParent")}
                </Button>
              </div>
              {pickerOpen && (
                <div className="rounded border p-2 bg-muted/20">
                  <TagTreePicker
                    tree={tree}
                    value={parentId}
                    onChange={(newParentId) => {
                      setParentId(newParentId);
                      setPickerOpen(false);
                      setError(null);
                    }}
                    disabledReason={disabledReasonForParent}
                    includeTopLevel
                    label={t("tagDialog_parentLabel")}
                  />
                </div>
              )}
            </div>
          </Field>

          <Field>
            <FieldLabel>{t("tagDialog_colorLabel")}</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {TAG_COLORS.map((option, index) => (
                <button
                  key={option}
                  type="button"
                  aria-label={t("tagDialog_colorOption", [String(index + 1)])}
                  aria-pressed={color === option}
                  onClick={() => setColor(option)}
                  className={cn(
                    "size-7 rounded-full transition-all",
                    option.split(" ")[0].replace("/10", ""),
                    color === option ? "ring-2 ring-primary ring-offset-2" : "opacity-50 hover:opacity-100",
                  )}
                />
              ))}
            </div>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
              {t("settings_cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={pending} aria-busy={pending}>
              {t(initial ? "tagDialog_save" : "tagDialog_create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
