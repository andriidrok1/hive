import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function useQrSvg(url: string, size: "small" | "big" = "small"): string {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let alive = true;
    QRCode.toString(url, { type: "svg", margin: 1, width: size === "big" ? 360 : 48, color: { dark: "#e8ebf3", light: "#0000" } })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(""));
    return () => {
      alive = false;
    };
  }, [url, size]);
  return svg;
}

export function Qr({ url }: { url: string }) {
  const [big, setBig] = useState(false);
  const small = useQrSvg(url, "small");
  const large = useQrSvg(url, "big");
  return (
    <>
      <div className="qr" title={`Open ${url} on your phone`} onClick={() => setBig(true)} role="button" aria-label="QR code for the phone page">
        <div dangerouslySetInnerHTML={{ __html: small }} />
        <div className="url">{url.replace(/^https?:\/\//, "")}</div>
      </div>
      {big && (
        <div className="overlay" onClick={() => setBig(false)}>
          <div className="dialog qr-big" onClick={(e) => e.stopPropagation()}>
            <div dangerouslySetInnerHTML={{ __html: large }} />
            <div>{url}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              Phone page: edit contracts, send notes to agents
            </div>
          </div>
        </div>
      )}
    </>
  );
}
