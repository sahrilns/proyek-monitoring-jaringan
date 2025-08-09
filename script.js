window.onload = function () {
  const map = L.map("map", { updateWhenIdle: true }).setView(
    [-6.0447, 120.5442],
    16
  );
  L.tileLayer("https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
    maxZoom: 20,
    subdomains: ["mt0", "mt1", "mt2", "mt3"],
  }).addTo(map);

  const API_BASE_URL = "";
  const OLT_IP_CONFIG = "ate.gigabit.my.id";
  const OLT_PORT_CONFIG = "60303";

  let isAnimationEnabled = true;
  let isEditMode = false;

  const icons = {
    server: L.icon({ iconUrl: "icons/server.png", iconSize: [40, 40] }),
    switch: L.icon({ iconUrl: "icons/switch.png", iconSize: [28, 28] }),
    odp: L.icon({ iconUrl: "icons/odp.png", iconSize: [30, 30] }),
    client: L.icon({ iconUrl: "icons/client.png", iconSize: [26, 26] }),
    clientOffline: L.icon({
      iconUrl: "icons/client_offline.png",
      iconSize: [26, 26],
    }),
    clientPoweroff: L.icon({
      iconUrl: "icons/client_poweroff.png",
      iconSize: [26, 26],
    }),
    htb: L.icon({ iconUrl: "icons/client.png", iconSize: [26, 26] }),
  };

  const layerGroups = {
    server: L.layerGroup().addTo(map),
    odp: L.layerGroup().addTo(map),
    client: L.layerGroup().addTo(map),
    htb: L.layerGroup().addTo(map),
    switch: L.layerGroup().addTo(map),
    main_path: L.layerGroup().addTo(map),
    client_path: L.layerGroup().addTo(map),
  };

  const deviceDataMap = {};
  const manualGroupSet = new Set();

  function getType(name) {
    const n = name.toLowerCase();
    if (n.includes("server")) return "server";
    if (n.includes("switch")) return "switch";
    if (n.includes("odp")) return "odp";
    if (n.includes("htb")) return "htb";
    return "client";
  }

  async function initializeMap() {
    try {
      // 1. Ambil info pengguna yang sedang login
      const userResponse = await fetch(`${API_BASE_URL}/api/user_info`);
      if (!userResponse.ok) {
        // Jika sesi habis atau error, paksa kembali ke halaman login
        if (userResponse.status === 401) {
          window.location.href = "/login";
        }
        throw new Error("Gagal mendapatkan info pengguna.");
      }
      const userInfo = await userResponse.json();

      // 2. Sembunyikan elemen edit jika bukan admin
      if (userInfo.username !== "admin") {
        const modeEditMenuItem = document
          .getElementById("toggle-edit-mode")
          .closest(".menu-item");
        if (modeEditMenuItem) {
          modeEditMenuItem.style.display = "none";
        }
      }

      // 3. Lanjutkan memuat data peta seperti biasa
      const [devices, routes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/devices`).then((res) => res.json()),
        fetch(`${API_BASE_URL}/api/routes`).then((res) => res.json()),
      ]);
      processManualRoutes(routes);
      processMappingData(devices);
      drawPolylines();
      fetchOntStatus();
    } catch (error) {
      console.error("Error saat inisialisasi peta:", error);
      // Jangan tampilkan pesan error teknis ke user, cukup arahkan ke login jika perlu
      if (!window.location.pathname.endsWith("/login.html")) {
        window.location.href = "/login";
      }
    }
  }

  function processManualRoutes(routesData) {
    manualGroupSet.clear();
    Object.keys(routesData).forEach((groupKey) => {
      const route = routesData[groupKey];
      manualGroupSet.add(groupKey.toLowerCase().replace(/\s+/g, ""));
      L.polyline(route, {
        color: "black",
        weight: 2.5,
        opacity: 0.9,
        interactive: false,
      }).addTo(layerGroups.main_path);
    });
  }

  function processMappingData(data) {
    data.forEach((entry) => {
      if (!entry.name || !entry.lat || !entry.lng) return;
      const type = getType(entry.name);
      const marker = L.marker([parseFloat(entry.lat), parseFloat(entry.lng)], {
        icon: icons[type],
        draggable: false,
      });
      marker.db_id = entry.id;
      marker.on("dragend", function (event) {
        const position = event.target.getLatLng();
        fetch(`${API_BASE_URL}/api/devices/${marker.db_id}/location`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat: position.lat, lng: position.lng }),
        });
      });
      const targetLayerGroup =
        type === "htb" ? layerGroups.htb : layerGroups[type];
      deviceDataMap[entry.name] = {
        marker,
        ...entry,
        parent: entry.parent_name,
        type,
        status: "unknown",
      };
      marker.addTo(targetLayerGroup);
      updatePopupForDevice(entry.name);
    });
  }

  function drawPolylines() {
    Object.values(deviceDataMap).forEach((device) => {
      if (device.parent && deviceDataMap[device.parent]) {
        const parentDevice = deviceDataMap[device.parent];
        const groupKey = `${device.parent}-${device.name}`
          .toLowerCase()
          .replace(/\s+/g, "");
        if (manualGroupSet.has(groupKey)) return;
        const from = parentDevice.marker.getLatLng();
        const to = device.marker.getLatLng();
        const parentType = parentDevice.type;
        const childType = device.type;
        let targetLayer = layerGroups.client_path;
        let options = {
          color: "red",
          weight: 2,
          className: "",
          interactive: false,
        };
        if (
          parentType === "server" ||
          (parentType === "odp" && childType === "odp") ||
          (parentType === "switch" && childType === "odp")
        ) {
          targetLayer = layerGroups.main_path;
          options = {
            color: "black",
            weight: 2.5,
            opacity: 0.9,
            interactive: false,
          };
        }
        const polyline = L.polyline([from, to], options).addTo(targetLayer);
        device.polyline = polyline;
      }
    });
  }

  function fetchOntStatus() {
    const statusIndicator = document.getElementById("status-indicator");
    const statusText = document.getElementById("status-text");
    fetch(`${API_BASE_URL}/api/ont_data`)
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(`Gagal fetch: ${response.statusText}`)
      )
      .then((data) => {
        updateDeviceStatuses(data);
        statusIndicator.style.backgroundColor = "#28a745";
        statusText.textContent = `Terhubung | Update: ${new Date().toLocaleTimeString(
          "id-ID"
        )}`;
      })
      .catch((error) => {
        console.error("Error fetching ONT data:", error);
        statusIndicator.style.backgroundColor = "#dc3545";
        statusText.textContent = "Koneksi ke server gagal.";
      })
      .finally(() => setTimeout(fetchOntStatus, 15000));
  }

  function updateDeviceStatuses(snmpData) {
    const ontDataMap = snmpData.reduce((map, ont) => {
      const ontKey = `${ont.slot}.${ont.pon_port}.${ont.onu_index}`;
      map[ontKey] = ont;
      return map;
    }, {});
    Object.values(deviceDataMap).forEach((device) => {
      let newStatus = device.status;
      if (device.ont_id) {
        const data = ontDataMap[device.ont_id];
        newStatus = data ? data.status : "offline";
        if (data) {
          device.mac = data.mac || "N/A";
          device.rx_power = data.rx_power;
        }
      } else if (device.type === "htb") {
        newStatus = "online";
      } else if (device.type === "client" && !device.ont_id) {
        newStatus = "offline";
      }
      if (device.status !== newStatus) {
        device.status = newStatus;
        updateDeviceMarker(device);
        if (device.parent && deviceDataMap[device.parent]) {
          updatePopupForDevice(device.parent);
        }
      }
      updatePopupForDevice(device.name);
    });
  }

  function updateDeviceMarker(device) {
    let newIcon = icons[device.type];
    if (device.type === "client" || device.type === "htb") {
      switch (device.status) {
        case "online":
          newIcon = icons.client;
          break;
        case "poweroff":
          newIcon = icons.clientPoweroff;
          break;
        default:
          newIcon = icons.clientOffline;
      }
    }
    if (device.marker && newIcon) device.marker.setIcon(newIcon);
    if (device.polyline) {
      const parentDevice = deviceDataMap[device.parent];
      const isMainPath =
        parentDevice &&
        (parentDevice.type === "server" ||
          (parentDevice.type === "odp" && device.type === "odp") ||
          (parentDevice.type === "switch" && device.type === "odp"));
      if (!isMainPath) {
        let pathColor = "#dc3545";
        switch (device.status) {
          case "online":
            pathColor = "#28a745";
            break;
          case "poweroff":
            pathColor = "#fd7e14";
            break;
        }
        device.polyline.setStyle({ color: pathColor });
        const pathElement = device.polyline._path;
        if (pathElement) {
          if (isAnimationEnabled) {
            pathElement.classList.add("animated-dash-line");
          } else {
            pathElement.classList.remove("animated-dash-line");
          }
        }
      }
    }
  }

  function updatePopupForDevice(deviceName) {
    const device = deviceDataMap[deviceName];
    if (!device || !device.marker) return;
    let content = "";
    switch (device.type) {
      case "server":
        content = createServerPopup(device);
        break;
      case "switch":
        content = createSwitchPopup(device);
        break;
      case "odp":
        content = createOdpPopup(device);
        break;
      case "client":
      case "htb":
        content = createClientPopup(device);
        break;
      default:
        content = `<b>${deviceName}</b>`;
    }
    if (device.marker.getPopup()) {
      device.marker.getPopup().setContent(content);
    } else {
      device.marker.bindPopup(content, { closeButton: false, minWidth: 250 });
    }
    const popupEl = device.marker
      .getPopup()
      ?.getElement()
      ?.querySelector(".custom-popup-body");
    if (popupEl) {
      const existingBtn = popupEl.querySelector(".delete-btn");
      if (isEditMode && !existingBtn) {
        const deleteBtn = L.DomUtil.create("button", "delete-btn", popupEl);
        deleteBtn.innerHTML = "Hapus Perangkat";
        L.DomEvent.on(deleteBtn, "click", () => {
          if (
            confirm(
              `Anda yakin ingin menghapus ${device.name}? Tindakan ini tidak bisa dibatalkan.`
            )
          ) {
            fetch(`${API_BASE_URL}/api/devices/${device.id}`, {
              method: "DELETE",
            })
              .then((res) => {
                if (!res.ok)
                  throw new Error("Gagal menghapus perangkat dari server.");
                alert(`${device.name} berhasil dihapus.`);
                location.reload();
              })
              .catch((err) => alert(err.message));
          }
        });
      } else if (!isEditMode && existingBtn) {
        L.DomUtil.remove(existingBtn);
      }
    }
  }

  function createServerPopup(serverData) {
    return `<div class="custom-popup-container"><div class="custom-popup-header">🖥️ ${
      serverData.name
    }</div><div class="custom-popup-body"><div class="popup-row"><span class="popup-label">Status</span><span class="popup-value status-online">Online</span></div><div class="popup-row"><span class="popup-label">IP Address</span><span class="popup-value">${OLT_IP_CONFIG}:${OLT_PORT_CONFIG}</span></div><div class="popup-row"><span class="popup-label">Fungsi</span><span class="popup-value">${
      serverData.deskripsi || "Server Utama"
    }</span></div></div></div>`;
  }

  function createSwitchPopup(switchData) {
    const children = Object.values(deviceDataMap).filter(
      (d) => d.parent === switchData.name
    );
    const childrenListHTML =
      children
        .map(
          (c) =>
            `<li><span class="status-dot status-${
              c.status || "unknown"
            }"></span> ${c.name}</li>`
        )
        .join("") || "<li>Tidak ada perangkat terhubung.</li>";
    return `<div class="custom-popup-container"><div class="custom-popup-header">🔀 ${
      switchData.name
    }</div><div class="custom-popup-body"><div class="popup-grid" style="grid-template-columns: 1fr;"><div class="popup-stat"><h4>Total Perangkat</h4><span class="status-unknown">${
      children.length
    }</span></div></div><div class="popup-row"><span class="popup-label">Fungsi</span><span class="popup-value">${
      switchData.deskripsi || "Switch / Hub"
    }</span></div><hr style="border:none; border-top:1px solid #eee; margin:5px 0;"><ul class="odp-client-list">${childrenListHTML}</ul></div></div>`;
  }

  function createOdpPopup(odpData) {
    const clients = Object.values(deviceDataMap).filter(
      (d) =>
        d.parent === odpData.name && (d.type === "client" || d.type === "htb")
    );
    const onlineCount = clients.filter((c) => c.status === "online").length;
    const offlineCount = clients.filter((c) => c.status === "offline").length;
    const poweroffCount = clients.filter((c) => c.status === "poweroff").length;
    const clientListHTML =
      clients
        .map(
          (c) =>
            `<li><span class="status-dot status-${
              c.status || "unknown"
            }"></span> ${c.name}</li>`
        )
        .join("") || "<li>Tidak ada klien terhubung.</li>";
    return `<div class="custom-popup-container"><div class="custom-popup-header">📦 ${
      odpData.name
    }</div><div class="custom-popup-body"><div class="popup-grid"><div class="popup-stat"><h4>Online</h4><span class="status-online">${onlineCount}</span></div><div class="popup-stat"><h4>Offline</h4><span class="status-offline">${offlineCount}</span></div><div class="popup-stat"><h4>Power Off</h4><span class="status-poweroff">${poweroffCount}</span></div></div><div class="popup-row"><span class="popup-label">Kapasitas Port</span><span class="popup-value">${
      clients.length
    } dari ${
      odpData.kapasitas || "N/A"
    }</span></div><hr style="border:none; border-top:1px solid #eee; margin:5px 0;"><ul class="odp-client-list">${clientListHTML}</ul></div></div>`;
  }

  function createClientPopup(clientData) {
    const statusClass = `status-${clientData.status || "unknown"}`;
    const statusText = clientData.status
      ? clientData.status.charAt(0).toUpperCase() + clientData.status.slice(1)
      : "Unknown";
    if (clientData.ont_id) {
      let rxPowerHTML = `<span class="status-loss">N/A</span>`;
      if (clientData.rx_power && clientData.rx_power !== "N/A") {
        const rxValue = parseFloat(clientData.rx_power);
        let rxColorClass = "status-online";
        if (rxValue < -27) rxColorClass = "status-offline";
        else if (rxValue < -25) rxColorClass = "status-unknown";
        rxPowerHTML = `<span class="${rxColorClass}">${rxValue.toFixed(
          2
        )} dBm</span>`;
      }
      return `<div class="custom-popup-container"><div class="custom-popup-header">${
        clientData.name
      }</div><div class="custom-popup-body"><div class="popup-grid" style="grid-template-columns: 1fr 1fr;"><div class="popup-stat"><h4>STATUS</h4><span class="status-badge ${statusClass}">${statusText}</span></div><div class="popup-stat"><h4>SINYAL (Rx)</h4>${rxPowerHTML}</div></div><div class="popup-row"><span class="popup-label">Parent</span><span class="popup-value">${
        clientData.parent || "N/A"
      }</span></div><div class="popup-row"><span class="popup-label">MAC</span><span class="popup-value">${
        clientData.mac || "N/A"
      }</span></div><div class="popup-row"><span class="popup-label">Tipe</span><span class="popup-value">OLT</span></div></div></div>`;
    } else {
      return `<div class="custom-popup-container"><div class="custom-popup-header">${
        clientData.name
      }</div><div class="custom-popup-body"><div class="popup-grid" style="grid-template-columns: 1fr;"><div class="popup-stat"><h4>STATUS</h4><span class="status-badge ${statusClass}">${statusText}</span></div></div><div class="popup-row"><span class="popup-label">Parent</span><span class="popup-value">${
        clientData.parent || "N/A"
      }</span></div><div class="popup-row"><span class="popup-label">Tipe</span><span class="popup-value">Non-OLT</span></div></div></div>`;
    }
  }

  const searchBox = document.getElementById("search-box");
  let searchResultMarker = null;
  searchBox.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase();
    if (searchResultMarker) {
      map.removeLayer(searchResultMarker);
      searchResultMarker = null;
    }
    if (query.length < 2) return;
    for (const deviceName in deviceDataMap) {
      if (deviceName.toLowerCase().includes(query)) {
        const device = deviceDataMap[deviceName];
        const latLng = device.marker.getLatLng();
        map.flyTo(latLng, 19);
        device.marker.openPopup();
        searchResultMarker = L.circleMarker(latLng, {
          radius: 20,
          color: "#ffc107",
          fillColor: "#ffc107",
          fillOpacity: 0.4,
        }).addTo(map);
        break;
      }
    }
  });

  const hamburgerBtn = document.getElementById("hamburger-btn");
  const mainMenu = document.getElementById("main-menu");
  hamburgerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    mainMenu.classList.toggle("hidden");
    mainMenu.classList.toggle("visible");
  });
  window.addEventListener("click", () => {
    if (mainMenu.classList.contains("visible")) {
      mainMenu.classList.add("hidden");
      mainMenu.classList.remove("visible");
    }
  });
  mainMenu.addEventListener("click", (e) => e.stopPropagation());

  const addDeviceContainer = document.getElementById("add-device-container");
  document
    .getElementById("toggle-edit-mode")
    .addEventListener("change", function (e) {
      isEditMode = e.target.checked;
      addDeviceContainer.classList.toggle("hidden", !isEditMode);
      Object.values(deviceDataMap).forEach((device) =>
        isEditMode
          ? device.marker.dragging.enable()
          : device.marker.dragging.disable()
      );
      if (!isEditMode) {
        cancelRouteDrawing();
        map.getContainer().style.cursor = "";
      }
      Object.keys(deviceDataMap).forEach(updatePopupForDevice);
    });

  const modal = document.getElementById("device-modal");
  let newDeviceCoords = null;
  document.getElementById("add-device-btn").addEventListener("click", () => {
    mainMenu.classList.add("hidden");
    mainMenu.classList.remove("visible");
    map.getContainer().style.cursor = "crosshair";
    alert(
      "Mode Penempatan Aktif: Klik di lokasi pada peta untuk menempatkan perangkat baru."
    );
    map.once("click", (e) => {
      newDeviceCoords = e.latlng;
      map.getContainer().style.cursor = "";
      document.getElementById("form-name").value = "";
      document.getElementById("form-parent").value = "";
      document.getElementById("form-ont-id").value = "";
      document.getElementById("form-kapasitas").value = "";
      document.getElementById("form-deskripsi").value = "";
      document.getElementById("form-type").value = "client";
      toggleFormFields();
      modal.style.display = "flex";
    });
  });

  const formTypeSelect = document.getElementById("form-type");
  formTypeSelect.addEventListener("change", toggleFormFields);
  function toggleFormFields() {
    const type = formTypeSelect.value;
    document
      .getElementById("olt-fields")
      .classList.toggle("hidden", type !== "client");
    document
      .getElementById("odp-fields")
      .classList.toggle("hidden", type !== "odp");
  }

  document.getElementById("save-device-btn").addEventListener("click", () => {
    const type = document.getElementById("form-type").value;
    const newDevice = {
      name: document.getElementById("form-name").value,
      parent_name: document.getElementById("form-parent").value,
      lat: newDeviceCoords.lat,
      lng: newDeviceCoords.lng,
      ont_id:
        type === "client" ? document.getElementById("form-ont-id").value : null,
      kapasitas:
        type === "odp" ? document.getElementById("form-kapasitas").value : null,
      deskripsi: document.getElementById("form-deskripsi").value,
    };
    if (!newDevice.name) {
      alert("Nama perangkat tidak boleh kosong!");
      return;
    }
    fetch(`${API_BASE_URL}/api/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newDevice),
    })
      .then((res) =>
        res.ok
          ? res.json()
          : Promise.reject("Gagal menyimpan perangkat ke server.")
      )
      .then(() => {
        alert("Perangkat berhasil ditambahkan!");
        location.reload();
      })
      .catch((err) => alert(err));
    modal.style.display = "none";
  });

  document.getElementById("cancel-device-btn").addEventListener("click", () => {
    modal.style.display = "none";
    map.getContainer().style.cursor = "";
  });

  document
    .getElementById("toggle-filters-btn")
    .addEventListener("click", () => {
      document.getElementById("filters-panel").classList.toggle("hidden");
    });

  const drawRouteBtn = document.getElementById("draw-route-btn");
  const drawingControls = document.getElementById("drawing-controls");
  const saveRouteBtn = document.getElementById("save-route-btn");
  const cancelRouteBtn = document.getElementById("cancel-route-btn");

  let isDrawingRoute = false;
  let routeDrawingState = {
    step: 0,
    startNode: null,
    endNode: null,
    points: [],
    tempLayer: L.layerGroup().addTo(map),
  };

  drawRouteBtn.addEventListener("click", () => {
    isDrawingRoute ? cancelRouteDrawing() : startRouteDrawing();
  });
  saveRouteBtn.addEventListener("click", saveRoute);
  cancelRouteBtn.addEventListener("click", cancelRouteDrawing);

  function startRouteDrawing() {
    isDrawingRoute = true;
    routeDrawingState.step = 1;
    drawRouteBtn.textContent = "Batalkan Menggambar";
    drawRouteBtn.style.backgroundColor = "#c82333";
    mainMenu.classList.add("hidden");
    mainMenu.classList.remove("visible");
    alert("Mode Gambar Jalur Aktif:\n1. Klik pada perangkat AWAL.");
    Object.values(deviceDataMap).forEach((device) =>
      device.marker.on("click", onRouteMarkerClick)
    );
  }

  function cancelRouteDrawing() {
    isDrawingRoute = false;
    routeDrawingState.tempLayer.clearLayers();
    routeDrawingState = {
      step: 0,
      startNode: null,
      endNode: null,
      points: [],
      tempLayer: routeDrawingState.tempLayer,
    };
    drawRouteBtn.textContent = "Gambar Jalur Baru";
    drawRouteBtn.style.backgroundColor = "";
    map.getContainer().style.cursor = "";
    drawingControls.classList.add("hidden");
    map.off("click", onRouteMapClick);
    Object.values(deviceDataMap).forEach((device) =>
      device.marker.off("click", onRouteMarkerClick)
    );
  }

  function onRouteMarkerClick(e) {
    if (!isDrawingRoute) return;
    const clickedDeviceName = Object.keys(deviceDataMap).find(
      (key) => deviceDataMap[key].marker === e.target
    );

    if (routeDrawingState.step === 1) {
      routeDrawingState.startNode = clickedDeviceName;
      L.circleMarker(e.latlng, { color: "lime", radius: 8 }).addTo(
        routeDrawingState.tempLayer
      );
      routeDrawingState.step = 2;
      alert(
        "Perangkat AWAL dipilih.\n2. Sekarang, klik pada perangkat TUJUAN."
      );
    } else if (routeDrawingState.step === 2) {
      if (clickedDeviceName === routeDrawingState.startNode) return;
      routeDrawingState.endNode = clickedDeviceName;
      L.circleMarker(e.latlng, { color: "red", radius: 8 }).addTo(
        routeDrawingState.tempLayer
      );

      Object.values(deviceDataMap).forEach((device) =>
        device.marker.off("click", onRouteMarkerClick)
      );

      routeDrawingState.step = 3;
      map.getContainer().style.cursor = "crosshair";
      drawingControls.classList.remove("hidden");
      map.on("click", onRouteMapClick);
      alert(
        "Perangkat TUJUAN dipilih.\n3. Klik di peta untuk menambahkan titik-titik jalur."
      );
    }
  }

  function onRouteMapClick(e) {
    if (routeDrawingState.step !== 3) return;
    routeDrawingState.points.push(e.latlng);
    L.circleMarker(e.latlng, { color: "yellow", radius: 4 }).addTo(
      routeDrawingState.tempLayer
    );

    const allPointsForPolyline = [
      deviceDataMap[routeDrawingState.startNode].marker.getLatLng(),
      ...routeDrawingState.points,
    ];
    if (routeDrawingState.endNode) {
      allPointsForPolyline.push(
        deviceDataMap[routeDrawingState.endNode].marker.getLatLng()
      );
    }

    routeDrawingState.tempLayer.eachLayer((layer) => {
      if (layer instanceof L.Polyline) {
        routeDrawingState.tempLayer.removeLayer(layer);
      }
    });
    L.polyline(allPointsForPolyline, {
      color: "yellow",
      dashArray: "5, 5",
    }).addTo(routeDrawingState.tempLayer);
  }

  function saveRoute() {
    if (
      routeDrawingState.step !== 3 ||
      !routeDrawingState.startNode ||
      !routeDrawingState.endNode
    ) {
      alert(
        "Gagal menyimpan. Pastikan Anda sudah memilih perangkat awal dan tujuan."
      );
      cancelRouteDrawing();
      return;
    }

    const startCoords =
      deviceDataMap[routeDrawingState.startNode].marker.getLatLng();
    const endCoords =
      deviceDataMap[routeDrawingState.endNode].marker.getLatLng();
    const finalPoints = [startCoords, ...routeDrawingState.points, endCoords];

    const group_name = `${routeDrawingState.startNode}-${routeDrawingState.endNode}`;
    const points_payload = finalPoints.map((p) => ({ lat: p.lat, lng: p.lng }));

    fetch(`${API_BASE_URL}/api/routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_name: group_name, points: points_payload }),
    })
      .then((res) =>
        res.ok ? res.json() : Promise.reject("Gagal menyimpan jalur ke server.")
      )
      .then(() => {
        alert(
          `Jalur dari ${routeDrawingState.startNode} ke ${routeDrawingState.endNode} berhasil disimpan!`
        );
        location.reload();
      })
      .catch((err) => {
        alert(err.message);
        cancelRouteDrawing();
      });
  }

  document
    .getElementById("filter-server")
    .addEventListener("change", (e) =>
      e.target.checked
        ? map.addLayer(layerGroups.server)
        : map.removeLayer(layerGroups.server)
    );
  document
    .getElementById("filter-switch")
    .addEventListener("change", (e) =>
      e.target.checked
        ? map.addLayer(layerGroups.switch)
        : map.removeLayer(layerGroups.switch)
    );
  document
    .getElementById("filter-odp")
    .addEventListener("change", (e) =>
      e.target.checked
        ? map.addLayer(layerGroups.odp)
        : map.removeLayer(layerGroups.odp)
    );
  document
    .getElementById("filter-client")
    .addEventListener("change", (e) =>
      e.target.checked
        ? map.addLayer(layerGroups.client)
        : map.removeLayer(layerGroups.client)
    );
  document
    .getElementById("filter-htb")
    .addEventListener("change", (e) =>
      e.target.checked
        ? map.addLayer(layerGroups.htb)
        : map.removeLayer(layerGroups.htb)
    );
  document
    .getElementById("filter-main-path")
    .addEventListener("change", (e) =>
      e.target.checked
        ? map.addLayer(layerGroups.main_path)
        : map.removeLayer(layerGroups.main_path)
    );
  document
    .getElementById("filter-client-path")
    .addEventListener("change", (e) =>
      e.target.checked
        ? map.addLayer(layerGroups.client_path)
        : map.removeLayer(layerGroups.client_path)
    );
  document
    .getElementById("toggle-animation")
    .addEventListener("change", (e) => {
      isAnimationEnabled = e.target.checked;
      Object.values(deviceDataMap).forEach(updateDeviceMarker);
    });

  initializeMap();
};
