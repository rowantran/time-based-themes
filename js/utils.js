// Helper: Log debug messages.
function logDebug(text) {
    if (DEBUG_MODE) {
        console.log("automaticDark DEBUGGING: " + text);
    }
}

// Helper: Print the error.
function onError(error) {
    console.log("automaticDark Error: " + error);
}

function isThemeImageDataUrl(image) {
    return image.startsWith("data:image/png;base64,")
        || image.startsWith("data:image/jpeg;base64,");
}

async function themeImageBlobToDataUrl(blob) {
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.onabort = () => reject(new Error("Theme image read was aborted."));
        reader.readAsDataURL(blob);
    });
    if (isThemeImageDataUrl(dataUrl)) {
        return dataUrl;
    }

    // Firefox only accepts PNG/JPEG data URLs, even though static themes can
    // include SVG/GIF images. Rasterize other formats instead of sending another
    // invalid URL. PNG/JPEG bytes (including animated PNGs) stay unchanged above;
    // this fallback necessarily uses one frame for other animated formats.
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    let width = image.naturalWidth;
    let height = image.naturalHeight;
    if ((!width || !height) && blob.type === "image/svg+xml") {
        // ViewBox-only SVGs can have no intrinsic size. Give them a viewport
        // with the usual theme-header height while preserving their aspect ratio.
        const svg = new DOMParser().parseFromString(await blob.text(), "image/svg+xml").documentElement;
        const viewBox = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
        const ratio = viewBox.length === 4 && viewBox.every(Number.isFinite)
            && viewBox[2] > 0 && viewBox[3] > 0
            ? viewBox[2] / viewBox[3] : 1.5;
        height = height || (width ? width / ratio : 200);
        width = width || height * ratio;
        image.width = Math.max(1, Math.round(width));
        image.height = Math.max(1, Math.round(height));
    }
    if (!width || !height) {
        throw new Error("Theme image has no drawable dimensions.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

// theme.getCurrent() returns absolute moz-extension: image URLs, but
// theme.update() only accepts packaged relative URLs, image data URLs, or
// gradient objects. Copy images from the enabled theme into data URLs so
// reapplying its colors/properties does not discard its artwork or fail
// validation (Firefox bug 1618563). No additional host permissions are needed
// to read static theme images.
async function prepareThemeForUpdate(theme) {
    if (!theme.images) {
        return theme;
    }

    // A theme can use the same image in more than one background layer.
    // Share its conversion within this update, but do not cache failed reads
    // or retain large image data URLs for the rest of the browser session.
    const conversions = new Map();
    function convertImage(image) {
        // Keep accepted data URLs, packaged relative paths, and gradients intact.
        const needsConversion = typeof image === "string"
            && (image.startsWith("moz-extension://")
                || (image.startsWith("data:image/") && !isThemeImageDataUrl(image)));
        if (!needsConversion) {
            return Promise.resolve(image);
        }
        if (!conversions.has(image)) {
            conversions.set(image, fetch(image)
                .then((response) => {
                    if (!response.ok) {
                        throw new Error("Could not read theme image: " + response.status);
                    }
                    return response.blob();
                })
                .then(themeImageBlobToDataUrl));
        }
        return conversions.get(image);
    }

    // Firefox validates ignored legacy/experiment image keys too. This
    // extension has no theme experiment and only these two keys are painted.
    const images = {};
    if (theme.images.theme_frame !== undefined) {
        images.theme_frame = theme.images.theme_frame;
    }
    if (theme.images.additional_backgrounds !== undefined) {
        images.additional_backgrounds = theme.images.additional_backgrounds;
    }
    if (images.theme_frame !== undefined) {
        images.theme_frame = await convertImage(images.theme_frame);
    }
    if (images.additional_backgrounds) {
        images.additional_backgrounds = await Promise.all(
            images.additional_backgrounds.map(convertImage));
    }
    return {...theme, images};
}

// Helper: Figure out if a time is in-between two times.
// Return true if it is daytime.
// Return false if it is nighttime.
function timeInBetween(
        curHours, curMins, 
        sunriseHours, sunriseMins, 
        sunsetHours, sunsetMins
    ){
    logDebug("Start timeInBetween");

    let curTimeInMins = curHours * 60 + parseInt(curMins);
    let sunriseInMins = sunriseHours * 60 + parseInt(sunriseMins);
    let sunsetInMins = sunsetHours * 60 + parseInt(sunsetMins);
    let difference = sunsetInMins - sunriseInMins;

    // If the difference is negative, 
    // we know the "sunrise" is on the previous day.
    if (difference < 0) {
        difference += 1440;
        if (sunriseInMins <= curTimeInMins || curTimeInMins < sunsetInMins) {
            // So, we need to do the comparisons a little differently.
            logDebug("timeInBetween determined it is currently daytime (" + curHours + ":" + curMins + ") because sunrise is " + sunriseHours + ":" + sunriseMins + " and sunset is " + sunsetHours + ":" + sunsetMins + ".");
            return true;
        }
    }
    else {
        if (sunriseInMins <= curTimeInMins && curTimeInMins < sunsetInMins) {
            logDebug("timeInBetween determined it is currently daytime.");
            return true;
        }
}
    logDebug("timeInBetween determined it is currently nighttime.");
    return false;
}

function addLeadZero (num){
    logDebug("Start addLeadZero");

    if (num < 10) {
        return "0" + num;
    }
    else {
        return num;
    }
}

// Helper:
// Set each key in storage only if overrideDefault is true or
// that key has never been set before.
function setStorage(obj, overrideDefault = false) {
    logDebug("Start setStorage");

    return Promise.all(Object.keys(obj).map((item) => {
        return browser.storage.local.get(item)
            .then((fetchedItem) => {
                if (overrideDefault || isEmpty(fetchedItem)) {
                    return browser.storage.local.set({[item]: obj[item]})
                        .then(() => {}, onError);
                }
            }, onError);
    }));
}

// Helper: Get all active alarms.
function logAllAlarms() {
    logDebug("Start logAllAlarms");

    return browser.alarms.getAll()
        .then(function(alarms) {
            logDebug("Log all active alarms...");
            if (DEBUG_MODE) {
                console.log(alarms);
            }
        });
}

// Helper: Check if the object is empty.
function isEmpty(obj) {
    for(var key in obj) {
        if(obj.hasOwnProperty(key))
            return false;
    }
    return true;
}

// Take in the time as hours and minutes and
// return the next time it will occur as
// milliseconds since the epoch.
function convertToNextMilliEpoch(hours, minutes) {
    let returnDate = new Date(Date.now());
    returnDate.setHours(hours);
    returnDate.setMinutes(minutes);
    returnDate.setSeconds(0);
    returnDate.setMilliseconds(0);

    // If the specified time has already occurred, 
    // the next time it will occur will be the next day.
    if (returnDate < Date.now()) {
        returnDate.setDate(returnDate.getDate() + 1);
    }
    return returnDate.getTime();
}

// Helper:
// Convert the time from a Date object to a string in the format of HH:MM.
function convertDateToString(date) {
    let hours = date.getHours();
    let minutes = date.getMinutes();
    return addLeadZero(hours) + ":" + addLeadZero(minutes);
}

