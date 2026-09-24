export default function CartLoading() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-5 md:py-8" aria-busy="true">
      <div className="h-4 w-40 animate-pulse bg-black/10" />
      <div className="mt-4 border-b border-[#3B2219]/15 pb-4">
        <p className="eyebrow text-[#70584B]">Mua sắm</p>
        <div className="mt-2 h-9 w-48 animate-pulse bg-black/10 sm:h-10 md:h-12" />
      </div>
      <div className="mt-8 grid gap-8">
        {[0, 1].map((item) => (
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-6" key={item}>
            <div className="aspect-[4/5] animate-pulse bg-black/10" />
            <div className="space-y-3 py-2">
              <div className="h-5 w-1/2 animate-pulse bg-black/10" />
              <div className="h-4 w-1/3 animate-pulse bg-black/10" />
              <div className="h-11 w-40 animate-pulse bg-black/10" />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Đang tải giỏ hàng.</span>
    </div>
  );
}
