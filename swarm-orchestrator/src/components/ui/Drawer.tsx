import { Drawer as VaulDrawer } from "vaul";

/** Props for the Drawer root container. */
interface DrawerProps {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: React.ReactNode;
}

interface DrawerContentProps {
  readonly children: React.ReactNode;
  readonly className?: string;
}

const SNAP_POINTS = [0.4, 0.7, 0.95] as const;

function DrawerRoot({ open, onOpenChange, children }: DrawerProps): React.ReactElement {
  return (
    <VaulDrawer.Root
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={[...SNAP_POINTS]}
      fadeFromIndex={2}
    >
      {children}
    </VaulDrawer.Root>
  );
}

function DrawerTrigger({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <VaulDrawer.Trigger asChild>{children}</VaulDrawer.Trigger>;
}

function DrawerContent({ children, className }: DrawerContentProps): React.ReactElement {
  return (
    <VaulDrawer.Portal>
      <VaulDrawer.Overlay
        style={{
          position: "fixed",
          inset: 0,
          background: "oklch(0.06 0.02 220 / 0.6)",
          backdropFilter: "blur(4px)",
        }}
      />
      <VaulDrawer.Content
        className={className}
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "oklch(0.11 0.03 220)",
          border: "1px solid oklch(0.28 0.05 220)",
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12,
          outline: "none",
          display: "flex",
          flexDirection: "column",
          maxHeight: "95dvh",
        }}
      >
        <VaulDrawer.Handle
          style={{
            background: "oklch(0.35 0.05 220)",
            width: 48,
            height: 4,
            borderRadius: 2,
            margin: "12px auto 0",
          }}
        />
        <div
          className="scroll-area"
          style={{
            flex: 1,
            overflow: "auto",
            padding: 16,
          }}
        >
          {children}
        </div>
      </VaulDrawer.Content>
    </VaulDrawer.Portal>
  );
}

function DrawerTitle({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <VaulDrawer.Title
      style={{
        fontFamily: "var(--font-display, 'Syne Variable', sans-serif)",
        fontWeight: 700,
        fontSize: "1.125rem",
        color: "oklch(0.95 0.02 220)",
        marginBottom: 12,
      }}
    >
      {children}
    </VaulDrawer.Title>
  );
}

function DrawerClose({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <VaulDrawer.Close asChild>{children}</VaulDrawer.Close>;
}

/**
 * Vaul-based bottom drawer with snap points and OKLCH glass-morphism overlay.
 *
 * Compound component: `Drawer.Root`, `Drawer.Trigger`, `Drawer.Content`,
 * `Drawer.Title`, `Drawer.Close`.
 */
export const Drawer = {
  Root: DrawerRoot,
  Trigger: DrawerTrigger,
  Content: DrawerContent,
  Title: DrawerTitle,
  Close: DrawerClose,
} as const;
