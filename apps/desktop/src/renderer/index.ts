const canvas = document.getElementById("gpu") as HTMLCanvasElement | null;
if (canvas) {
  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
  };
  resize();
  window.addEventListener("resize", resize);
}
