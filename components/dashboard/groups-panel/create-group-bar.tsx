import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColorPicker } from "@/components/ui/color-picker";
import { useGroupsStore } from "@/store/groups-store";
import type { TabGroupColor } from "@/lib/chrome/tab-groups";

export function CreateGroupBar() {
  const createGroup = useGroupsStore(s => s.createGroup);
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<TabGroupColor>("blue");
  const [open, setOpen] = React.useState(false);

  const handleCreate = React.useCallback(() => {
    if (!name.trim()) { return; }
    createGroup(name.trim(), color, true);
    setName("");
    setColor("blue");
    setOpen(false);
  }, [createGroup, name, color]);

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4 mr-1" />
        New Group
      </Button>
    );
  }

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-card">
      <Input
        autoFocus
        placeholder="Group name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { handleCreate(); }
          if (e.key === "Escape") { setOpen(false); }
        }}
        className="h-8 text-sm"
      />
      <ColorPicker value={color} onChange={setColor} size="sm" />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={handleCreate}>
          Create
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
