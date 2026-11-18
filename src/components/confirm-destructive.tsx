"use client";

import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/**
 * The one confirmation pattern for destructive or hard-to-reverse actions. The
 * dialog names the object and states the real consequence; Radix returns focus
 * to the trigger on close and keeps the dialog keyboard operable. `trigger` is
 * rendered as the trigger element itself (asChild), so it should be a button.
 */
export function ConfirmDestructive({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = true,
  open,
  onOpenChange,
}: {
  /** Omit when the dialog is opened programmatically through `open`. */
  trigger?: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  destructive?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      {/* The dialog lives inside table rows and cards that have click handlers. */}
      <AlertDialogContent onClick={(event) => event.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={cn(destructive && "bg-[#C85A63] text-white hover:bg-[#b94b54]")}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
