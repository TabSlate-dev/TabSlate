import { LoginForm } from "@/components/login-form";
import { LanguageSelector } from "@/components/language-selector";
import { useTheme } from "@/lib/theme";

export function AuthPage() {
  const { resolvedTheme } = useTheme();
  const previewSrc = resolvedTheme === "dark"
    ? "/login-preview-dark.webp"
    : "/login-preview-light.webp";

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Left: form */}
      <div className="flex flex-col gap-4 p-6 md:p-10 relative">
        <div className="absolute top-6 right-6 md:top-10 md:right-10 z-10">
          <LanguageSelector />
        </div>
        <div className="flex justify-center gap-2 md:justify-start">
          <div className="flex items-center gap-2 font-medium">
            <img src="/wxt.svg" alt="TabSlate" className="size-5" />
            TabSlate
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <LoginForm />
          </div>
        </div>
      </div>

      {/* Right: decorative panel (hidden on mobile) */}
      <div className="relative hidden overflow-hidden bg-slate-100 lg:flex dark:bg-zinc-950">
        <img
          src={previewSrc}
          alt="TabSlate dashboard preview"
          draggable={false}
          className="absolute inset-0 size-full select-none object-cover object-center animate-in fade-in duration-500"
        />
      </div>
    </div>
  );
}
