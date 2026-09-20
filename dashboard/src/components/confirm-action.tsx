import { useState, type ReactNode } from "react";
import type { Mutate } from "../lib/api";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog";

type Request = {
  title: string;
  description: string;
  details?: ReactNode;
  body: object;
  message: string;
  confirmLabel: string;
};

export function ConfirmAction({
  label,
  accessibleLabel,
  danger = false,
  disabled,
  request,
  mutate,
}: {
  label: string;
  accessibleLabel?: string;
  danger?: boolean;
  disabled: boolean;
  request: Request;
  mutate: Mutate;
}) {
  // Polling must not change the operation the user is currently reviewing.
  const [review, setReview] = useState<Request>();
  return (
    <AlertDialog
      open={Boolean(review)}
      onOpenChange={(open) => setReview(open ? request : undefined)}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant={danger ? "destructive" : "outline"}
          size="sm"
          disabled={disabled}
          aria-label={accessibleLabel}
        >
          {label}
        </Button>
      </AlertDialogTrigger>
      {review && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{review.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {review.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {review.details}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={danger ? "destructive" : "default"}
              disabled={disabled}
              onClick={() => void mutate(review.body, review.message)}
            >
              {review.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
