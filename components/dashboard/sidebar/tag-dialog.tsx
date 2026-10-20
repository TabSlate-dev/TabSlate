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
import type { Tag } from "@/lib/types";
import { tagNameError } from "@/lib/tag-name";

interface TagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tag being edited; omitted when creating one. */
  initial?: Tag;
  /** Names of the other tags, used to reject duplicates. */
  takenNames: readonly string[];
  onSubmit: (name: string, color: string) => void;
}

export function TagDialog({ open, onOpenChange, initial, takenNames, onSubmit }: TagDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(initial?.name ?? "");
  const [color, setColor] = React.useState<string>(initial?.color ?? TAG_COLORS[0]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setColor(initial?.color ?? TAG_COLORS[0]);
      setError(null);
    }
  }, [open, initial]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = tagNameError(name, takenNames);
    if (problem) {
      setError(t(problem === "empty" ? "tagDialog_errorEmpty" : "tagDialog_errorDuplicate"));
      return;
    }
    onSubmit(name.trim(), color);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("settings_cancel")}
            </Button>
            <Button type="submit" size="sm">
              {t(initial ? "tagDialog_save" : "tagDialog_create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
