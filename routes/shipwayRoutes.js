const express = require('express');
const router = express.Router();
const Controller = require('../controllers/shipwayControllers');

// Shipment Booking
router.post('/pushOrders', Controller.pushOrders);

router.post('/labelGeneration', Controller.labelGeneration);

router.post('/CreateOrderManifest', Controller.CreateOrderManifest);

router.post('/createPickup', Controller.createPickup);

router.post('/OnholdOrders', Controller.OnholdOrders);

router.post('/CancelOrders', Controller.CancelOrders);

router.post('/CancelShipment', Controller.CancelShipment);

router.get('/getOrders', Controller.getOrders);

router.get('/getAllOrders', Controller.getAllOrders);

// NDR
router.post('/InsertOrder', Controller.InsertOrder);

router.post('/ReAttempt', Controller.ReAttempt);

router.post('/RTO', Controller.RTO);

router.post('/OrderDetails', Controller.OrderDetails);

// Carriers
router.get('/getcarrier', Controller.getcarrier);

// Warehouse
router.post('/warehouse', Controller.warehouse);

router.get('/getwarehouses', Controller.getwarehouses);

// Pincode Serviceable
router.get('/pincodeserviceable', Controller.pincodeserviceable);

module.exports = router;
