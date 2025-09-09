const express = require("express");
const router = express.Router();
const Controller = require("../controllers/shipwayControllers");

const rateLimiter = require("../middlewares/rateLimiter");

// Shipment Booking
router.post("/pushOrders", rateLimiter, Controller.pushOrders);

router.post("/labelGeneration", rateLimiter, Controller.labelGeneration);

router.post('/CreateOrderManifest', rateLimiter, Controller.CreateOrderManifest);

router.post('/createPickup', rateLimiter, Controller.createPickup);

router.post('/OnholdOrders', rateLimiter, Controller.OnholdOrders);

router.post('/CancelOrders', rateLimiter, Controller.CancelOrders);

router.post('/CancelShipment', rateLimiter, Controller.CancelShipment);

router.get('/getOrders', rateLimiter, Controller.getOrders);

router.get('/getAllOrders', rateLimiter, Controller.getAllOrders);

// NDR
router.post('/InsertOrder', rateLimiter, Controller.InsertOrder);

router.post('/ReAttempt', rateLimiter, Controller.ReAttempt);

router.post('/RTO', rateLimiter, Controller.RTO);

router.post('/OrderDetails', rateLimiter, Controller.OrderDetails);

// Carriers
router.get('/getcarrier', rateLimiter, Controller.getcarrier);

// Warehouse
router.post('/warehouse', rateLimiter, Controller.warehouse);

router.get('/getwarehouses', rateLimiter, Controller.getwarehouses);

// Pincode Serviceable
router.get('/pincodeserviceable', rateLimiter, Controller.pincodeserviceable);

module.exports = router;
