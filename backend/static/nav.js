document.querySelectorAll(".nav-links a").forEach((a) => {
  if (a.getAttribute("href") === window.location.pathname) {
    a.classList.add("active");
  }
});
