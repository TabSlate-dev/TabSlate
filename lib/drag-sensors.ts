import {
  PointerSensor,
} from "@dnd-kit/core";
import type {
  PointerActivationConstraint,
  PointerSensorOptions,
} from "@dnd-kit/core";

/**
 * dnd-kit stores listeners in a plain `{ [eventName]: handler }` object,
 * so two sensors that both listen to `onPointerDown` overwrite each other.
 *
 * SmartPointerSensor solves this by combining handle + body logic into ONE
 * sensor.  When the pointer goes down on a `[data-drag-handle]` element the
 * drag activates with a tiny distance-1 constraint (virtually immediate).
 * Everywhere else it falls back to the configurable `activationConstraint`
 * passed via options (e.g. `{ delay: 250, tolerance: 5 }`).
 */

function isDragHandle(event: React.PointerEvent): boolean {
  let target = event.nativeEvent.target as Element | null;
  if (target && target.nodeType === Node.TEXT_NODE) {
    target = target.parentElement;
  }
  return !!target?.closest?.("[data-drag-handle]");
}

export class SmartPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler(
        { nativeEvent: event }: React.PointerEvent,
        options: PointerSensorOptions
      ) {
        if (!event.isPrimary || event.button !== 0) {
          return false;
        }

        // If the pointer landed on a drag-handle, force near-immediate
        // activation by patching the constraint to distance: 1.
        const target = (event.target as Element | null);
        const el = target?.nodeType === Node.TEXT_NODE
          ? target.parentElement
          : target;

        if (el?.closest?.("[data-drag-handle]")) {
          options.activationConstraint = { distance: 1 };
        }

        return true;
      },
    },
  ];
}
