import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Smartphone } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export function useQrSvg(url: string, width: number): string {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let alive = true;
    QRCode.toString(url, { type: "svg", margin: 1, width, color: { dark: "#fafafa", light: "#0000" } })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(""));
    return () => {
      alive = false;
    };
  }, [url, width]);
  return svg;
}

export function Qr({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const large = useQrSvg(url, 320);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-label="QR code for the phone page" title={url}>
        <Smartphone />
        <span className="font-mono text-xs text-muted-foreground">{url.replace(/^https?:\/\//, "").replace(/\/m$/, "")}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Phone page</DialogTitle>
            <DialogDescription>Edit contracts and send notes to agents from your phone.</DialogDescription>
          </DialogHeader>
          <div className="mx-auto [&_svg]:size-72" dangerouslySetInnerHTML={{ __html: large }} />
          <div className="text-center font-mono text-xs text-muted-foreground">{url}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}
