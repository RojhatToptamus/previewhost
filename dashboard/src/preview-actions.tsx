import { useRef, useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import type { Mutate } from "./lib/api";
import {
  deletionNeedsRetry,
  needsCleanup,
  pending,
  shortProject,
  type Entry,
} from "./lib/model";
import { Button } from "./components/ui/button";
import { AlertDialog } from "./components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./components/ui/dropdown-menu";
import {
  ConfirmationContent,
  type Confirmation,
} from "./components/confirm-action";
import { Path } from "./components/shared";

export type PreviewAction = {
  label: string;
  danger?: boolean;
  body: object;
  message: string;
};

export function previewActions(entry: Entry): PreviewAction[] {
  const { owner, preview: p, name } = entry;
  const result: PreviewAction[] = [];
  const request = pending(entry).find((request) => request.state === "pending");
  if (request)
    result.push({
      label: "Open private form",
      body: { action: "secretsOpen", owner: owner.id, id: request.id },
      message: "Private form requested in your system browser.",
    });
  if (!p) return result;
  if (p.candidate)
    result.push({
      label: p.active ? "Cancel update" : "Cancel startup",
      danger: true,
      body: {
        action: "cancel",
        owner: owner.id,
        name,
        attemptId: p.candidate.id,
      },
      message: "The selected attempt was canceled.",
    });
  if (
    (p.active || needsCleanup(p) || p.url) &&
    !deletionNeedsRetry(p) &&
    !p.busy
  )
    result.push({
      label: needsCleanup(p) ? "Retry cleanup" : "Stop",
      danger: !needsCleanup(p),
      body: {
        action: "stop",
        owner: owner.id,
        name,
        expected: {
          active: p.active?.id ?? null,
          candidate: p.candidate?.id ?? null,
          latest: p.latest?.id ?? null,
        },
      },
      message: "Preview stopped. Your database data is retained.",
    });
  if (
    !p.active &&
    !p.busy &&
    !p.candidate &&
    ["stopped", "failed"].includes(p.latest?.state ?? "") &&
    !needsCleanup(p)
  )
    result.push({
      label: p.latest?.state === "failed" ? "Retry start" : "Start preview",
      body: {
        action: "startAgain",
        owner: owner.id,
        name,
        attemptId: p.latest!.id,
      },
      message:
        "Startup requested with the same configuration and current source.",
    });
  return result;
}

function resetRequest(entry: Entry): Confirmation | undefined {
  const p = entry.preview;
  if (
    !p?.data?.resources.length ||
    !p.latest ||
    !(p.active || ["stopped", "failed"].includes(p.latest.state)) ||
    p.busy ||
    p.candidate ||
    (needsCleanup(p) && !deletionNeedsRetry(p))
  )
    return;
  return {
    title: `Reset data for ${p.name}?`,
    description: `Stops this preview, deletes the managed data below, then starts the ${p.active ? "serving" : "latest"} configuration and runs setup again. Deletion and job writes cannot be rolled back.`,
    details: <DataScope entry={entry} />,
    body: {
      action: "resetData",
      owner: entry.owner.id,
      name: p.name,
      resources: p.data.resources,
      expected: {
        active: p.active?.id ?? null,
        candidate: null,
        latest: p.latest.id,
      },
    },
    message: "Data deleted. Startup requested; check setup jobs.",
    confirmLabel: "Delete data and start",
  };
}

function DataScope({ entry }: { entry: Entry }) {
  return (
    <>
      <Path value={entry.owner.project ?? ""} />
      <ul className="list-disc pl-5">
        {entry.preview?.data?.resources.map((resource) => (
          <li key={resource.name}>
            {resource.name} ·{" "}
            {resource.type === "postgres" ? "PostgreSQL" : "Redis"}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        External databases and saved secrets are not deleted.
      </p>
    </>
  );
}

export function PreviewMenu({
  entry,
  mutate,
  acting,
  managementOnly = false,
}: {
  entry: Entry;
  mutate: Mutate;
  acting: boolean;
  managementOnly?: boolean;
}) {
  const [review, setReview] = useState<Confirmation>();
  const trigger = useRef<HTMLButtonElement>(null);
  const { owner, preview: p, name } = entry;
  if (owner.error) return null;
  const actions = managementOnly || owner.offline ? [] : previewActions(entry);
  const idle =
    !p?.active &&
    !p?.candidate &&
    !p?.busy &&
    !p?.url &&
    !pending(entry).length;
  const canDelete =
    idle && p?.data && (!needsCleanup(p) || deletionNeedsRetry(p));
  const canRemove = idle && !p?.data && !needsCleanup(p);
  const reset = resetRequest(entry);
  if (
    !actions.length &&
    !canDelete &&
    !canRemove &&
    !reset &&
    !(p?.active && p.url && !managementOnly)
  )
    return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            variant="ghost"
            size="icon-sm"
            disabled={acting}
            aria-label={`Actions for ${name ?? shortProject(owner)}`}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (review) event.preventDefault();
          }}
        >
          <DropdownMenuGroup>
            {!managementOnly && p?.active && p.url && (
              <DropdownMenuItem asChild>
                <a href={p.url} target="_blank" rel="noreferrer">
                  Open app
                </a>
              </DropdownMenuItem>
            )}
            {actions.map((action) => (
              <DropdownMenuItem
                key={action.label}
                onSelect={() => void mutate(action.body, action.message)}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          {(actions.length > 0 || (!managementOnly && p?.active)) &&
          (reset || canDelete || canRemove) ? (
            <DropdownMenuSeparator />
          ) : null}
          <DropdownMenuGroup>
            {reset && (
              <DropdownMenuItem onSelect={() => setReview(reset)}>
                Reset data…
              </DropdownMenuItem>
            )}
            {canDelete && (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  setReview({
                    title: `Delete data for ${name}?`,
                    description:
                      "Permanently deletes these managed databases. Nothing restarts. Deletion cannot be rolled back.",
                    details: <DataScope entry={entry} />,
                    body: {
                      action: "deleteData",
                      owner: owner.id,
                      name,
                      expected: {
                        attemptId: p.latest?.id ?? null,
                        resources: p.data!.resources,
                      },
                    },
                    message: "Managed data deleted.",
                    confirmLabel: "Delete data",
                  })
                }
              >
                Delete data…
              </DropdownMenuItem>
            )}
            {canRemove && (
              <DropdownMenuItem
                onSelect={() =>
                  setReview({
                    title: `Remove ${name ?? shortProject(owner)}?`,
                    description:
                      "Removes this entry and its retained logs. Source files and saved secrets stay untouched. An empty project closes and ends its private approvals.",
                    details: <Path value={owner.project ?? ""} />,
                    body: {
                      action: "remove",
                      owner: owner.id,
                      name,
                      attemptId: p?.latest?.id ?? null,
                    },
                    message: "Entry removed.",
                    confirmLabel: "Remove entry",
                  })
                }
              >
                Remove entry…
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) setReview(undefined);
        }}
      >
        <ConfirmationContent
          review={review}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          disabled={acting}
          danger
          mutate={mutate}
        />
      </AlertDialog>
    </>
  );
}
